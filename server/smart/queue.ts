import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { getOwner } from "@/server/auth";
import { can } from "@/server/access";
import { listItems } from "@/server/work/store";
import { listDecisions } from "@/server/work/decisions";
import { itemExcluded } from "./store";
import { specRefs, validateSpec } from "@/lib/jarvis-ui/validator";
import type { HydratedRef, ApprovalRow } from "@/lib/jarvis-ui/types";

export function approvalQueue(user: CurrentUser): HydratedRef {
  const ref = "approvals:pending";
  if (getOwner()?.id !== user.id) return { ref, unavailable: "forbidden" };
  const all = can(user, "work.use") ? listItems(user.id, { includeArchived: true }) : [];
  const map = new Map(all.map((i) => [i.id, i]));
  const safe = all.filter((i) => !itemExcluded(i, map));
  const excludedSessions = new Set(
    all
      .filter((i) => itemExcluded(i, map))
      .map((i) => i.sessionId)
      .filter(Boolean),
  );
  for (const link of getDb().select().from(schema.workLinks).where(eq(schema.workLinks.kind, "chat_session")).all()) {
    const item = map.get(link.itemId);
    if (item && itemExcluded(item, map) && link.targetId) excludedSessions.add(link.targetId);
  }
  const excludedWorkflows = new Set(
    getDb()
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.ownerId, user.id))
      .all()
      .filter((r) => {
        const item = map.get(r.itemId ?? r.areaId ?? "");
        return item && itemExcluded(item, map);
      })
      .map((r) => `workflow:${r.id}`),
  );
  const rows: ApprovalRow[] = listDecisions(user, safe)
    .entries.filter(
      (d) =>
        !excludedWorkflows.has(d.key) &&
        !excludedSessions.has(d.sessionId ?? "") &&
        ![...excludedSessions].some((id) => id && d.href === `/chat/${encodeURIComponent(id)}`),
    )
    .map((d) => ({ id: d.key, title: d.title, detail: d.question, href: d.href }));
  const surfaces = getDb()
    .select()
    .from(schema.uiSurfaces)
    .where(eq(schema.uiSurfaces.userId, user.id))
    .orderBy(desc(schema.uiSurfaces.updatedAt))
    .limit(100)
    .all();
  for (const surface of surfaces) {
    if (!surface.sessionId) continue;
    const state = JSON.parse(surface.stateJson) as { pending?: number };
    if (!state.pending) continue;
    const v = validateSpec(JSON.parse(surface.specJson));
    if (!v.ok || specRefs(v.spec).some((r) => r.startsWith("item:") && (!map.has(r.slice(5)) || itemExcluded(map.get(r.slice(5))!, map)))) continue;
    const session = getDb()
      .select()
      .from(schema.sessionMeta)
      .where(and(eq(schema.sessionMeta.sessionId, surface.sessionId), eq(schema.sessionMeta.userId, user.id)))
      .get();
    const href = surface.sessionId.startsWith("workflow:brief:")
      ? "/areas/brief"
      : surface.sessionId.startsWith("workflow:week:")
        ? "/areas/plan"
        : surface.sessionId.startsWith("dynamic:")
          ? `/more?smartCard=${encodeURIComponent(surface.sessionId.slice(8))}`
          : session
            ? `/chat/${encodeURIComponent(surface.sessionId)}`
            : "/decisions";
    rows.push({ id: surface.id, title: "Staged Smart reply", detail: `${state.pending} changes awaiting Apply`, href });
  }
  return { ref, kind: "approvals", rows: rows.slice(0, 50) };
}
