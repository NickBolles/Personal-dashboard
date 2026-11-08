import "server-only";
import type { CurrentUser } from "@/server/auth";
import { can } from "@/server/access";
import { listItems } from "./store";
import { agentRuns } from "./agent-runs";
import { conversationList } from "./conversations";
import { decidingRun, FAILED_DOT_MS, stalledRuns } from "@/lib/agent-runs";
import { RESUME_LIMITS, type ResumeConversationRow, type ResumeResponse, type ResumeRunRow } from "@/lib/resume";
import type { WorkItem } from "@/lib/work";

const chatHref = (id: string) => `/chat/${encodeURIComponent(id)}`;
const itemHref = (id: string) => `/areas?item=${encodeURIComponent(id)}`;

function pathOf(byId: Map<string, WorkItem>, id: string) {
  const parts: string[] = [];
  for (let c = byId.get(id); c && parts.length < 8; c = c.parentId ? byId.get(c.parentId) : undefined) parts.unshift(c.title);
  return parts.join(" › ");
}

/** Everything in flight + recent conversations, from Jarvis's own data only. */
export async function resumeHub(user: CurrentUser, opts: { revalidate?: boolean } = {}, now = Date.now()): Promise<ResumeResponse> {
  const items = listItems(user.id);
  const byId = new Map(items.map((i) => [i.id, i]));
  const runs = agentRuns(user, items);
  const runRows: ResumeRunRow[] = Object.values(runs.items)
    .filter((r) => r.live === "running" || r.live === "waiting" || (r.live === "failed" && r.liveAt && now - Date.parse(r.liveAt) < FAILED_DOT_MS))
    .filter((r) => byId.has(r.itemId) && !byId.get(r.itemId)!.archived)
    .map((r) => {
      const latest = decidingRun(r.agentRuns);
      const sessionId = r.sessionId ?? latest?.hermesSessionId ?? null;
      return {
        kind: "run" as const,
        key: `run:${r.itemId}`,
        itemId: r.itemId,
        title: latest?.title && r.live !== "idle" ? latest.title : r.title,
        path: pathOf(byId, r.itemId),
        live: r.live,
        approval: !!r.approval,
        stalled: stalledRuns(r, now).length > 0,
        who: r.who?.name ?? latest?.profile ?? null,
        at: r.liveAt,
        href: sessionId ? chatHref(sessionId) : itemHref(r.itemId),
        itemHref: itemHref(r.itemId),
        sessionId,
      };
    })
    .sort((a, b) => {
      const rank = (x: ResumeRunRow) => (x.live === "waiting" ? 0 : x.live === "running" ? 1 : 2);
      return rank(a) - rank(b) || (b.at ?? "").localeCompare(a.at ?? "");
    })
    .slice(0, RESUME_LIMITS.runs);

  let conversations: ResumeConversationRow[] = [];
  let unfiled = 0;
  let unread = 0;
  let unavailable = !can(user, "hermes.chat");
  let updating: boolean | undefined;
  if (!unavailable) {
    try {
      const list = await conversationList(user, "all", null, { revalidate: opts.revalidate });
      unfiled = list.unfiledCount;
      unread = list.counts?.unread ?? list.unreadCount;
      updating = list.updating;
      unavailable = list.unavailable.length > 0 && list.conversations.length === 0;
      conversations = list.conversations.slice(0, RESUME_LIMITS.conversations).map((c) => {
        const isUnfiled = !c.readOnly && (!c.placement || c.placement.inMisc);
        return {
          kind: "conversation" as const,
          key: `chat:${c.id}`,
          sessionId: c.id,
          title: c.title,
          preview: c.preview,
          path: isUnfiled ? null : (c.placement?.path ?? null),
          parentId: c.placement?.parentId ?? null,
          unfiled: isUnfiled,
          unread: !!c.unread,
          unreadCount: c.unreadCount ?? null,
          agentProfile: c.agentProfile ?? null,
          at: c.lastActiveAt,
          href: chatHref(c.id),
          itemHref: c.placement?.parentId ? itemHref(c.placement.parentId) : null,
        };
      });
    } catch {
      unavailable = true;
    }
  }
  return {
    runs: runRows,
    conversations,
    counts: {
      running: runRows.filter((r) => r.live === "running").length,
      waiting: runRows.filter((r) => r.live === "waiting").length,
      unread,
      unfiled,
    },
    conversationsUnavailable: unavailable,
    ...(updating ? { updating } : {}),
    fetchedAt: new Date(now).toISOString(),
  };
}
