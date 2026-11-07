import "server-only";
import { eq } from "drizzle-orm";
import type { CurrentUser } from "@/server/auth";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { areaIndex } from "@/lib/map-rollup";
import { effectiveAutonomy, policyFor, type AwayRun, type Proposal } from "@/lib/away";
import { agentItems, requestOwnerChange, TOOL_BY_NAME, type DESTRUCTIVE_OPS } from "@/server/agent-access/tools";
import { withVia } from "@/server/work/actor";
import { listItems, updateItem } from "@/server/work/store";
import { DECISION_DETAIL_MAX } from "@/lib/decisions";
import { capture } from "@/server/work/inbox";
import type { AgentPrincipal } from "@/server/agent-access/tokens";

const LIFECYCLE: readonly string[] = ["settle", "abandon", "supersede", "archive", "move"];

export function applyProposals(user: CurrentUser, areaId: string, jobTitle: string, profile: string, proposals: Proposal[]) {
  const result: Pick<AwayRun, "changes" | "decisions" | "refused"> = { changes: [], decisions: [], refused: [] };
  const agent: AgentPrincipal = { user, profile, via: `agent:${profile}`, tokenId: "scheduled", scopes: [] };
  const call = (name: string, args: Record<string, unknown>) => {
    const tool = TOOL_BY_NAME.get(name)!;
    const result = withVia(agent.via, () => tool.run(tool.input.parse(args), { agent, correlationId: "scheduled-proposals" }));
    if (result instanceof Promise) throw new Error("Scheduled policy writes must be local and synchronous");
    return result;
  };
  for (const p of proposals) {
    const label = p.intent.replaceAll("_", " ");
    const refuse = (reason: string) => result.refused.push({ intent: p.intent, label: `${label}: ${reason}` });
    const items = listItems(user.id);
    const area = items.find((i) => i.id === areaId);
    const target = agentItems(user.id).byId.get(p.itemId ?? areaId);
    const areaOf = areaIndex(items);
    if (
      !area ||
      !target ||
      (target.id !== areaId && areaOf.get(target.id) !== areaId) ||
      effectiveAutonomy(area) === "off" ||
      effectiveAutonomy(target) === "off"
    ) {
      refuse("outside this area");
      continue;
    }
    const policy = policyFor(effectiveAutonomy(area), p.intent);
    if (policy === "refuse") {
      refuse("owner action only");
      continue;
    }
    try {
      if (policy === "decision") {
        // Store on the target unless it can't hold a decision (one is already open, or it's a conversation);
        // then fall back to the area, but keep naming the ORIGINAL target in the question (#230).
        const dest = target.decision || target.kind === "conversation" ? area : target;
        if (dest.decision) {
          refuse("a decision is already open");
          continue;
        }
        const elsewhere = dest.id !== target.id;
        const lifecycle = LIFECYCLE.includes(p.intent);
        const subject = lifecycle
          ? `${label} “${target.title}”${p.title ? ` · ${p.title}` : ""}`
          : `${label}${p.title ? ` · ${p.title}` : ""}${target.id !== areaId ? ` on “${target.title}”` : ""}`;
        const note = elsewhere ? ` (asked here: “${target.title}” ${target.decision ? "already has an open decision" : "is a conversation"})` : "";
        const question = `${jobTitle}: ${subject}${note}${p.why ? `. ${p.why}` : ""}`.slice(0, 460);
        // The owner must see WHAT would be done: persist the proposed content with the decision (#230).
        const detail = p.text ? [p.title, p.text].filter(Boolean).join("\n\n").slice(0, DECISION_DETAIL_MAX) : undefined;
        if (lifecycle && !elsewhere) {
          // Shared proposal path never performs the requested operation.
          withVia(agent.via, () =>
            requestOwnerChange(agent, { itemId: dest.id, op: p.intent as (typeof DESTRUCTIVE_OPS)[number], reason: question, detail }, "scheduled-proposals", [
              "Do it",
              "Skip",
            ]),
          );
        } else {
          // Same as jarvis_raise_decision, plus the proposed content. A lifecycle request stored on the
          // area is a plain question naming the target, so it never reads as "archive the area".
          withVia(agent.via, () =>
            updateItem(
              user,
              dest.id,
              { decision: { question: `@${agent.profile}: ${question}`.slice(0, 500), choices: ["Do it", "Skip"], ...(detail ? { detail } : {}) } },
              "scheduled-proposals",
            ),
          );
        }
        const saved = listItems(user.id).find((i) => i.id === dest.id)!;
        result.decisions.push({
          itemId: dest.id,
          itemTitle: dest.title,
          question: saved.decision!.question,
          open: true,
          ...(elsewhere ? { targetId: target.id, targetTitle: target.title } : {}),
        });
      } else if (p.intent === "create_note" || p.intent === "create_thread") {
        if (!p.title) {
          refuse("missing title");
          continue;
        }
        const out = call(
          p.intent === "create_note" ? "jarvis_add_note" : "jarvis_create_item",
          p.intent === "create_note"
            ? { itemId: target.id, title: p.title, body: p.text }
            : { parentId: target.id, title: p.title, kind: "thread", summary: p.text },
        ) as { item: { id: string; title: string } };
        result.changes.push({ intent: p.intent, label, itemId: out.item.id, itemTitle: out.item.title });
      } else if (p.intent === "update_next_action") {
        if (!p.text?.trim()) {
          refuse("missing text");
          continue;
        }
        call("jarvis_update_item", { id: target.id, nextAction: p.text });
        result.changes.push({ intent: p.intent, label, itemId: target.id, itemTitle: target.title });
      } else if (p.intent === "file_to_inbox") {
        if (!p.title && !p.text?.trim()) {
          refuse("missing text");
          continue;
        }
        withVia(agent.via, () =>
          getDb().transaction(() => {
            // No recursive AI follow-up for an agent-created capture. The original capture path is reused.
            const entry = capture(user, { text: [p.title, p.text].filter(Boolean).join("\n"), investigate: "off" }, "scheduled-proposals");
            const at = new Date().toISOString();
            getDb()
              .insert(schema.workOps)
              .values({
                id: newId("op"),
                userId: user.id,
                itemId: areaId,
                kind: "edit",
                via: agent.via,
                payload: JSON.stringify({
                  scheduledCapture: {
                    id: entry.id,
                    updatedAt: getDb().select().from(schema.workInbox).where(eq(schema.workInbox.id, entry.id)).get()!.updatedAt,
                  },
                }),
                createdAt: at,
              })
              .run();
            getDb()
              .insert(schema.workEvents)
              .values({ id: newId(), itemId: areaId, actor: user.id, kind: "edit", via: agent.via, reason: `Captured in Inbox: ${entry.title}`, at })
              .run();
            result.changes.push({ intent: p.intent, label, itemId: areaId, itemTitle: entry.title });
          }),
        );
      }
    } catch (e) {
      refuse(e instanceof Error ? e.message.slice(0, 120) : "couldn't apply");
    }
  }
  return result;
}
