import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { can } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { resolveAgent } from "@/server/agents/routing";
import { conversationAgent } from "@/server/areas";
import { buildCatchUpPrompt } from "@/lib/catch-up";
import { pathIndex } from "@/server/search-index";
import { detectSensitivity } from "@/server/ai/rules";
import type { AgentResolution } from "@/lib/agents";
import { areaIndex } from "@/lib/map-rollup";
import type { WorkItem } from "@/lib/work";
import { listItems } from "./store";
import { listDecisions } from "./decisions";
import { listActivity } from "./activity";
import { agentRuns } from "./agent-runs";
import { getSetting } from "@/server/settings";

/** Only live, AI-eligible top-level areas may host the portfolio coordinator. */
export function globalCoordinatorArea(user: CurrentUser): WorkItem | null {
  const areas = listItems(user.id).filter((i) => i.kind === "area" && i.parentId === null && !i.archived && i.settings?.aiPolicy !== "excluded");
  const configured = getSetting<unknown>("global_coordinator_area_id");
  return (
    areas.find((a) => a.id === configured) ??
    areas.find((a) => a.settings?.agentMode === "chiefofstaff") ??
    areas.find((a) => a.title.trim().toLowerCase() === "portfolio") ??
    null
  );
}

export type CoordinatorInfo = {
  area: { id: string; title: string };
  /** the area's agent mode and who actually answers (routing flag, routes, keys) */
  agent: AgentResolution;
  /** the area's coordinator conversation: the latest conversation filed directly under the area */
  sessionId: string | null;
  sessionTitle: string | null;
  /** AI-excluded areas: no AI context, no catch-up prompt */
  excluded: boolean;
  /** "Catch me up" text, shown in the composer; only sent when the owner taps Send */
  prompt: string | null;
};

/** The latest non-archived conversation filed directly under the area (null when none). */
export function coordinatorSession(items: WorkItem[], areaId: string): WorkItem | null {
  return (
    items
      .filter((c) => c.parentId === areaId && c.kind === "conversation" && c.sessionId && !c.archived)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))[0] ?? null
  );
}

/** Coordinator sessions per area for the Decisions inbox "post to coordinator" offer. */
export function coordinatorSessions(items: WorkItem[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of items.filter((i) => i.parentId === null && !i.archived)) {
    const s = coordinatorSession(items, a.id);
    if (s?.sessionId && a.settings?.aiPolicy !== "excluded") out.set(a.id, s.sessionId);
  }
  return out;
}

/** Everything the coordinator pane needs for one area. Read-only. */
export function coordinatorFor(user: CurrentUser, areaId: string): CoordinatorInfo {
  const items = listItems(user.id);
  const area = items.find((i) => i.id === areaId && i.parentId === null);
  if (!area) throw new HttpError(404, "not_found", "That area isn't here");
  const excluded = area.settings?.aiPolicy === "excluded";
  const session = coordinatorSession(items, area.id);
  // An existing coordinator conversation answers on the profile it was created
  // on (#169); the area's current mode only decides for a new conversation.
  const agent =
    (session?.sessionId ? conversationAgent(user, session.sessionId, session.id) : null) ??
    resolveAgent(area.settings?.agentMode ?? null, { id: area.id, title: area.title });
  if (excluded) return { area: { id: area.id, title: area.title }, agent, sessionId: null, sessionTitle: null, excluded, prompt: null };
  const areaOf = areaIndex(items);
  const index = pathIndex(items);
  const inArea = items.filter((i) => i.id !== area.id && areaOf.get(i.id) === area.id && !index.aiExcluded(i.id));
  const ids = new Set(inArea.map((i) => i.id));
  const decisions = listDecisions(user, items)
    .entries.filter((d) => d.itemId && ids.has(d.itemId))
    .map((d) => ({ title: d.title, question: d.question }));
  let activity: { at: string; verb: string; title: string | null; actor: string }[] = [];
  try {
    activity = listActivity(user, { item: area.id, descendants: true, limit: 12 })
      .items.filter((a) => !a.object?.id || !index.aiExcluded(a.object.id))
      .map((a) => ({
        at: a.at,
        verb: a.verb,
        title: a.object?.title ?? null,
        actor: a.actor.name,
      }));
  } catch {
    activity = [];
  }
  const runs = agentRuns(user, items);
  const agents = runs.active.filter((a) => a.areaId === area.id && ids.has(a.itemId));
  const prompt = buildCatchUpPrompt({
    area: { ...area, aiPolicy: area.settings?.aiPolicy ?? null },
    items: inArea,
    decisions,
    activity,
    agents,
    sensitive: (t) => detectSensitivity(t) === "credentials",
  });
  return { area: { id: area.id, title: area.title }, agent, sessionId: session?.sessionId ?? null, sessionTitle: session?.title ?? null, excluded, prompt };
}

/** Last time the coordinator conversation had a Jarvis-started run (for the pane header). */
export function lastRunAt(user: CurrentUser, sessionId: string | null): string | null {
  if (!sessionId || !can(user, "hermes.chat")) return null;
  const r = getDb()
    .select({ at: schema.runs.startedAt })
    .from(schema.runs)
    .where(and(eq(schema.runs.userId, user.id), inArray(schema.runs.sessionId, [sessionId])))
    .orderBy(desc(schema.runs.startedAt))
    .limit(1)
    .get();
  return r?.at ?? null;
}
