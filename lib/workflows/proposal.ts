/**
 * AI-drafted workflow proposals (W3): "Save chat as workflow" and "Describe
 * it". The model returns a draft split into parts; the owner accepts, edits
 * or drops each part; nothing is saved until the owner taps Save (the result
 * is created as a DRAFT workflow). Finance chats are refused before any
 * transcript reaches the model.
 */
import { z } from "zod";
import { isFinanceContext } from "@/lib/chat-context";
import { validateDefinition, type DefinitionIssue, type WorkflowDefinition } from "./definition";
import { blankDefinition } from "./builder";

export const PROPOSAL_PARTS = ["basics", "instructions", "capture", "startForm"] as const;
export type ProposalPart = (typeof PROPOSAL_PARTS)[number];
export type PartDecision = "accept" | "drop";

/** What the model may propose. Shape-checked loosely here; the assembled definition goes through validateDefinition. */
export const proposalSchema = z
  .object({
    basics: z
      .object({
        name: z.string().max(60),
        slug: z.string().max(40),
        icon: z.string().max(30).optional(),
        description: z.string().max(280).optional(),
        area: z.string().max(120).nullable().optional(),
      })
      .strict()
      .optional(),
    instructions: z.string().max(4000).optional(),
    capture: z.record(z.string(), z.unknown()).optional(),
    startForm: z
      .object({ title: z.string().max(80).optional(), fields: z.array(z.unknown()).max(20) })
      .strict()
      .optional(),
    rationale: z.string().max(600).optional(),
  })
  .strict();
export type WorkflowProposal = z.infer<typeof proposalSchema>;

export type ChatSource = {
  title?: string;
  areaPath?: string | null;
  /** refs attached to the chat (context picks, links) */
  refs?: { type?: string; id?: string; label?: string; url?: string }[];
};

/** Finance chats (filed under Finance, or carrying finance refs) never go to the AI builder. */
export function refuseFinanceChat(src: ChatSource): { refused: true; reason: string } | { refused: false } {
  const area = (src.areaPath ?? "").trim();
  if (/^finance(\s*\/|$)/i.test(area)) return { refused: true, reason: "Finance chats can't become workflows" };
  if (/\bfinance\b/i.test(src.title ?? "") && /\b(budget|account|transaction|spend)/i.test(src.title ?? ""))
    return { refused: true, reason: "Finance chats can't become workflows" };
  if ((src.refs ?? []).some((r) => isFinanceContext(r)))
    return { refused: true, reason: "This chat includes Finance context, so it can't be sent to the builder" };
  return { refused: false };
}

/** Assemble a definition from the accepted parts on top of a base (blank or the current draft). */
export function applyProposal(
  proposal: WorkflowProposal,
  decisions: Partial<Record<ProposalPart, PartDecision>>,
  base: WorkflowDefinition = blankDefinition(),
): WorkflowDefinition {
  const take = (p: ProposalPart) => decisions[p] === "accept";
  let def: WorkflowDefinition = { ...base, routing: { ...base.routing } };
  if (take("basics") && proposal.basics) {
    const b = proposal.basics;
    def = { ...def, name: b.name, slug: b.slug, ...(b.description ? { description: b.description } : {}) };
    if (b.icon) def.icon = b.icon as WorkflowDefinition["icon"];
    if (b.area !== undefined) def.routing.area = b.area;
    if (def.triggers) def.triggers = def.triggers.map((t) => (t.kind === "palette" ? { ...t, command: `/${def.slug}` } : t));
  }
  if (take("instructions") && proposal.instructions) def.instructions = proposal.instructions;
  if (take("capture") && proposal.capture) def.capture = proposal.capture as WorkflowDefinition["capture"];
  if (take("startForm") && proposal.startForm) {
    def.forms = {
      ...(def.forms ?? {}),
      start: { ...(proposal.startForm.title ? { title: proposal.startForm.title } : {}), fields: proposal.startForm.fields as never },
    };
  }
  return def;
}

/** Validate the assembled draft; issues are reported per proposal part so the review UI can flag the part. */
export function validateProposal(
  proposal: unknown,
  decisions: Partial<Record<ProposalPart, PartDecision>>,
  opts: { base?: WorkflowDefinition; excludedAreas?: string[] } = {},
): { ok: true; definition: WorkflowDefinition } | { ok: false; issues: (DefinitionIssue & { part: ProposalPart | null })[] } {
  const shape = proposalSchema.safeParse(proposal);
  if (!shape.success)
    return {
      ok: false,
      issues: shape.error.issues
        .slice(0, 10)
        .map((i) => ({ path: i.path.join("."), code: "invalid_proposal", message: i.message, part: partOf(i.path.join(".")) })),
    };
  const def = applyProposal(shape.data, decisions, opts.base);
  const r = validateDefinition(def, { excludedAreas: opts.excludedAreas });
  if (r.ok) return r;
  return { ok: false, issues: r.issues.map((i) => ({ ...i, part: partOf(i.path) })) };
}

function partOf(path: string): ProposalPart | null {
  const head = path.split(".")[0];
  if (head === "instructions") return "instructions";
  if (head === "capture") return "capture";
  if (head === "forms" || head === "startForm" || head === "start") return "startForm";
  if (["basics", "name", "slug", "icon", "description", "routing"].includes(head)) return "basics";
  return null;
}

/** Builder prompt for the Hermes subscription model (no provider keys; structured run). */
export function builderPrompt(input: { kind: "chat"; transcript: string; title?: string } | { kind: "describe"; description: string }): string {
  const src =
    input.kind === "chat"
      ? `Turn this conversation${input.title ? ` ("${input.title}")` : ""} into a reusable workflow. Quote the owner's own phrasing in the instructions.\n\n<transcript>\n${input.transcript.slice(0, 12000)}\n</transcript>`
      : `Draft a workflow from this description:\n${input.description.slice(0, 2000)}`;
  return [
    src,
    "",
    'Reply with ONE JSON object: {"basics":{"name","slug","icon","description","area"},"instructions":"…","capture":{…jarvis-workflow@1 capture…},"startForm":{"title","fields":[…]},"rationale":"…"}.',
    "Rules: no code, no HTML, no URLs; capture uses only text|longtext|date|datetime|time|number|bool|scripture_ref|place|person|tags (append ? for optional, list<…> for lists); start form fields bind to capture paths; never Finance.",
  ].join("\n");
}
