import "server-only";
import { z } from "zod";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { getSessionDetail } from "@/server/assistant";
import { conversationPlacement } from "@/server/work/conversations";
import { runStructured } from "@/integrations/hermes/structured";
import { builderPrompt, proposalSchema, refuseFinanceChat, type WorkflowProposal } from "@/lib/workflows/proposal";
import { isFinanceContext } from "@/lib/chat-context";
import { listItems } from "@/server/work/store";
import { effectiveAreaPolicy } from "@/server/ai/rules";

/** True when the item or any ancestor is Finance or has aiPolicy "excluded" (same rule as AI jobs). */
function inExcludedArea(userId: string, itemId: string | null | undefined): boolean {
  if (!itemId) return false;
  const byId = new Map(listItems(userId).map((i) => [i.id, i]));
  let cur = byId.get(itemId);
  for (let n = 0; cur && n < 50; n++) {
    if (effectiveAreaPolicy({ title: cur.title, aiPolicy: cur.settings?.aiPolicy ?? null }) === "excluded") return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

/**
 * AI drafts for the builder (W3): "Save chat as workflow" and "Describe it".
 * Returns a PROPOSAL only — nothing is written; the owner accepts/edits/drops
 * each part in the review and then saves a draft workflow through the normal
 * create route (validated there). Finance chats never reach the model.
 */
const EXAMPLE: WorkflowProposal = {
  basics: { name: "Teaching notes", slug: "teaching", icon: "book-open", description: "Live sermon notes", area: null },
  instructions: "Keep Scripture, teaching points, and my reflections distinct without adding outside commentary.",
  capture: { session: { type: "object", fields: { speaker: "text?" } }, points: { type: "list", of: "text" } },
  startForm: { title: "Start teaching notes", fields: [{ id: "speaker", bind: "session.speaker", type: "person", label: "Speaker" }] },
  rationale: "One line on why.",
};

export const draftBody = z.union([
  z.object({ kind: z.literal("chat"), sessionId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("describe"), description: z.string().min(10).max(2000) }).strict(),
]);

export async function draftWorkflow(user: CurrentUser, body: z.infer<typeof draftBody>, correlationId: string): Promise<{ proposal: WorkflowProposal }> {
  let task: string;
  if (body.kind === "chat") {
    const detail = await getSessionDetail(user, body.sessionId);
    const title = detail.session.title ?? "";
    const placement = conversationPlacement(user, body.sessionId, title).placement;
    const refusal = inExcludedArea(user.id, placement?.parentId)
      ? ({ refused: true, reason: "Chats in an area AI can't use can't become workflows" } as const)
      : refuseFinanceChat({
          title,
          areaPath: placement?.path ?? null,
          refs: (detail as { links?: { url?: string; label?: string }[] }).links ?? [],
        });
    if (refusal.refused) {
      audit({ actor: user.id, action: "workflow.draft", result: "rejected", correlationId, detail: { reason: "finance" } });
      throw new HttpError(403, "finance_blocked", refusal.reason);
    }
    const lines = detail.timeline
      .filter((t): t is Extract<typeof t, { kind: "user" | "assistant" }> => t.kind === "user" || t.kind === "assistant")
      .filter((t) => !isFinanceContext({ label: t.text }))
      .map((t) => `${t.kind === "user" ? "Owner" : "Assistant"}: ${t.text}`);
    task = builderPrompt({ kind: "chat", transcript: lines.join("\n"), title });
  } else {
    task = builderPrompt({ kind: "describe", description: body.description });
  }
  const proposal = await runStructured({
    source: "workflow_draft",
    label: "Workflow builder",
    task,
    schema: proposalSchema,
    example: EXAMPLE,
    interactive: true,
  });
  audit({ actor: user.id, action: "workflow.draft", result: "ok", correlationId, detail: { kind: body.kind } });
  return { proposal };
}
