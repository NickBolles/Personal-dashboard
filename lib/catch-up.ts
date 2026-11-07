/**
 * "Catch me up" prompt for an area's coordinator chat (Work from Jarvis batch 2).
 * Pure: builds the text the owner can send with one tap — nothing is sent here.
 * AI-excluded areas get no prompt. Credentials stay out; account numbers are masked.
 */
import { bucketOf, MAP_BUCKET_LABELS } from "@/lib/map-rollup";
import { liveLabel, type ItemAgentInfo } from "@/lib/agent-runs";
import type { WorkItem } from "@/lib/work";
import { maskAccountNumbers } from "@/lib/ai-redact";
import { detectSensitivity } from "@/server/ai/rules";

export type CatchUpArea = { id: string; title: string; systemKey?: string | null; aiPolicy?: string | null };
export type CatchUpActivity = { at: string; verb: string; title: string | null; actor: string };
export type CatchUpDecision = { title: string; question: string };

export type CatchUpInput = {
  area: CatchUpArea;
  /** every item under the area (any depth), area excluded */
  items: Pick<WorkItem, "id" | "title" | "status" | "decision" | "nextAction" | "kind" | "archived">[];
  decisions: CatchUpDecision[];
  activity: CatchUpActivity[];
  agents?: Pick<ItemAgentInfo, "title" | "live" | "who" | "approval">[];
  now?: Date;
  /** extra guard (server passes server/ai/rules detectSensitivity): true = leave this line out */
  sensitive?: (text: string) => boolean;
};

export const CATCH_UP_LIMITS = { items: 25, activity: 12, decisions: 10 } as const;

const clip = (s: string, n: number) => {
  s = maskAccountNumbers(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** null = this area must not go to AI. */
export function buildCatchUpPrompt(input: CatchUpInput): string | null {
  const { area } = input;
  if (area.aiPolicy === "excluded" || detectSensitivity(area.title) === "credentials") return null;
  const guard = input.sensitive;
  const sensitive = (...parts: (string | null | undefined)[]) => {
    const text = parts.filter(Boolean).join(" ");
    return detectSensitivity(text) === "credentials" || (!!guard && guard(text));
  };
  const open = input.items.filter((i) => !i.archived && i.kind !== "conversation" && bucketOf(i) !== "done" && !sensitive(i.title, i.nextAction));
  const lines: string[] = [];
  lines.push(`Catch me up on the "${area.title}" area.`);
  lines.push(
    "Using what you know and the snapshot below, tell me in a few bullets: what moved, what's stuck, what needs my decision, and what you suggest next. Don't start any work yet.",
  );
  lines.push("");
  lines.push(`Open items (${open.length}):`);
  if (!open.length) lines.push("- none");
  for (const i of open.slice(0, CATCH_UP_LIMITS.items)) {
    const next = i.nextAction ? ` — next: ${clip(i.nextAction, 120)}` : "";
    lines.push(`- ${clip(i.title, 120)} [${MAP_BUCKET_LABELS[bucketOf(i)]}]${next}`);
  }
  if (open.length > CATCH_UP_LIMITS.items) lines.push(`- …and ${open.length - CATCH_UP_LIMITS.items} more`);
  const decisions = input.decisions.filter((d) => !sensitive(d.title, d.question));
  lines.push("");
  lines.push(`Waiting on my decision (${decisions.length}):`);
  if (!decisions.length) lines.push("- none");
  for (const d of decisions.slice(0, CATCH_UP_LIMITS.decisions)) lines.push(`- ${clip(d.title, 100)}: ${clip(d.question, 200)}`);
  const agents = (input.agents ?? []).filter((a) => !sensitive(a.title, a.who?.name));
  if (agents.length) {
    lines.push("");
    lines.push("Agent runs:");
    for (const a of agents.slice(0, 10))
      lines.push(`- ${clip(a.title, 100)}: ${liveLabel(a.live, a.approval).toLowerCase()}${a.who ? ` (@${a.who.name})` : ""}`);
  }
  const act = input.activity.filter((a) => !sensitive(a.title, a.verb, a.actor));
  lines.push("");
  lines.push("Recent activity:");
  if (!act.length) lines.push("- none recorded");
  for (const a of act.slice(0, CATCH_UP_LIMITS.activity)) lines.push(`- ${a.at.slice(0, 10)} ${a.actor} ${a.verb}${a.title ? ` "${clip(a.title, 80)}"` : ""}`);
  return maskAccountNumbers(lines.join("\n"));
}
