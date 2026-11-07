import "server-only";
import type { CurrentUser } from "@/server/auth";
import { listItems } from "@/server/work/store";
import { areaDefaultsFor } from "@/server/references";
import { listAgentTokens } from "@/server/agent-access/tokens";
import { detectSensitivity } from "@/server/ai/rules";
import { isFinanceAreaLike } from "@/lib/finance-area";
import { STATUS_LABELS, isClosed, type WorkItem } from "@/lib/work";

export const FILED_CONTEXT_LIMITS = { items: 40, chars: 4000 } as const;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Where a filed conversation lives, for every run in it: the area/project path, a read-only snapshot of
 * the open items under the conversation's project (ids + status, so "ready to settle" etc. are visible)
 * and whether this Hermes profile can use Jarvis item tools. Without it, a chat routed to its area's own
 * profile got NO area context at all (the "Agent mode" hint is skipped there) and the agent answered
 * "no scoped area reference or item-access tools". Never for Finance or AI-excluded areas.
 */
export function filedChatContext(user: CurrentUser, sessionId: string, profile: string | null): string | null {
  const where = areaDefaultsFor(user, sessionId);
  if (!where) return null;
  const items = listItems(user.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const area = byId.get(where.area.id);
  if (!area || isFinanceAreaLike(area) || area.settings?.aiPolicy === "excluded") return null;
  const node = byId.get(where.nodeId);
  const scope = node?.kind === "conversation" ? (node.parentId ? byId.get(node.parentId) : undefined) : node;
  if (!scope) return null;
  const path: string[] = [];
  for (let n: WorkItem | undefined = scope, i = 0; n && i < 100; n = n.parentId ? byId.get(n.parentId) : undefined, i++) path.unshift(n.title);
  const safe = (...t: (string | null | undefined)[]) => detectSensitivity(t.filter(Boolean).join(" ")) === "none";
  // Ancestor titles go to Hermes on every turn: a sensitive one (e.g. "Tax return") means no snapshot at all.
  if (!safe(...path)) return null;
  // Descendants of the scope (breadth-first), open work only.
  const open: WorkItem[] = [];
  const queue = [scope.id];
  const kids = new Map<string, WorkItem[]>();
  for (const i of items) if (i.parentId && !i.archived) kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i]);
  while (queue.length && open.length < FILED_CONTEXT_LIMITS.items * 4) {
    for (const c of (kids.get(queue.shift()!) ?? []).sort((a, b) => a.sortOrder - b.sortOrder)) {
      if (c.kind === "conversation") continue;
      queue.push(c.id);
      if (!isClosed(c.status) && safe(c.title, c.nextAction)) open.push(c);
    }
  }
  const profileName = profile ?? "default";
  const tools = listAgentTokens(user.id).some((t) => !t.revokedAt && t.profile === profileName);
  const lines = [
    `This conversation is filed in Jarvis under: ${path.join(" › ")} (${scope.kind} id ${scope.id}).`,
    tools
      ? "You can read more and act with the Jarvis tools (jarvis_get_item, jarvis_tree, jarvis_update_item …). Settling, archiving and moving are owner-only: use jarvis_request_change."
      : "You have no Jarvis item tools in this conversation: use the snapshot below to answer. To change items, list the exact changes (item id + change) for the owner to apply; never claim you changed anything. Settling is always the owner's call.",
    `Open items there (${open.length}${open.length > FILED_CONTEXT_LIMITS.items ? `, first ${FILED_CONTEXT_LIMITS.items}` : ""}):`,
    ...(open.length ? [] : ["- none"]),
    ...open
      .slice(0, FILED_CONTEXT_LIMITS.items)
      .map((i) => `- [${STATUS_LABELS[i.status]}] ${clip(i.title, 100)} (${i.kind}, id ${i.id})${i.nextAction ? ` — next: ${clip(i.nextAction, 100)}` : ""}`),
  ];
  let text = lines.join("\n");
  if (text.length > FILED_CONTEXT_LIMITS.chars) text = `${text.slice(0, FILED_CONTEXT_LIMITS.chars - 1)}…`;
  return text;
}
