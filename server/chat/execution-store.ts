import "server-only";
import { and, desc, eq, or } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getOwner } from "@/server/auth";
import { markIndexStale } from "@/server/work/conversation-index";
import { mergeExecutionRecords, type ExecutionRecord, type ExecState } from "@/lib/chat-execution";
import { classifyUrl, findUrls } from "@/lib/chat-links";
import { scrub } from "@/integrations/hermes/normalize";

const T = schema.chatExecRecords;
const M = schema.sessionMeta;
export const EXECUTION_LIMIT = 200;
const validId = (id: string) => /^[A-Za-z0-9_.:-]{1,256}$/.test(id);
export function executionText(s: string | null | undefined, max = 4096) {
  const clean = scrub(s ?? undefined);
  // Bound UTF-8 bytes, not UTF-16 characters; stream decoding omits a cut multi-byte suffix.
  return clean === undefined ? null : new TextDecoder().decode(Buffer.from(clean.slice(0, max)).subarray(0, max), { stream: true });
}
export function executionState(status: string | null | undefined): ExecState {
  switch (status?.toLowerCase()) {
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    case "running":
      return "running";
    case "waiting":
    case "waiting_for_approval":
      return "waiting";
    default:
      return "unknown";
  }
}
/** A completion frame must explicitly name a terminal outcome; other values are unknown. */
export function executionCompletionState(status: string | null | undefined): ExecState {
  const state = executionState(status);
  return ["completed", "failed", "cancelled"].includes(state) ? state : "unknown";
}
export function executionLinks(text: string) {
  const links = findUrls(executionText(text, 8192) ?? "").flatMap((url) => {
    const l = classifyUrl(url);
    return l ? [{ url: l.url, kind: l.kind }] : [];
  });
  return [...new Map(links.map((l) => [l.url, l])).values()].slice(0, 30);
}
function record(row: typeof T.$inferSelect): ExecutionRecord {
  return {
    key: `${row.source}:${row.externalId}`,
    source: row.source,
    id: row.externalId,
    title: row.title,
    state: row.state,
    childSessionId: row.childSessionId,
    childProfile: row.childProfile,
    delegationId: row.delegationId,
    step: row.step,
    summary: row.summary,
    error: row.error,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    updatedAt: row.updatedAt,
    transcriptPath: row.transcriptPath,
    href: row.childSessionId ? `/chat/${encodeURIComponent(row.childSessionId)}` : null,
    links: JSON.parse(row.linksJson) as ExecutionRecord["links"],
  };
}
export function executionRecords(parentSessionId: string) {
  const rows = getDb().select().from(T).where(eq(T.parentSessionId, parentSessionId)).orderBy(desc(T.updatedAt)).limit(EXECUTION_LIMIT).all();
  const groups: (typeof rows)[] = [];
  const same = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    a.source === b.source &&
    (a.externalId === b.externalId ||
      (a.childSessionId && a.childSessionId === b.childSessionId) ||
      (a.subagentId && a.subagentId === b.subagentId) ||
      (a.transcriptPath && a.transcriptPath === b.transcriptPath) ||
      (a.delegationId && a.delegationId === b.delegationId && a.taskIndex !== null && a.taskIndex === b.taskIndex));
  for (const row of rows) {
    const matching = groups.filter((g) => g.some((r) => same(row, r)));
    if (!matching.length) {
      groups.push([row]);
      continue;
    }
    const target = matching[0]!;
    target.push(row);
    for (const group of matching.slice(1)) {
      target.push(...group);
      groups.splice(groups.indexOf(group), 1);
    }
  }
  // A late event can bridge a list-discovered child id and an earlier handle-only event.
  // Merge explicit identity aliases at read time without deleting retained source evidence.
  return mergeExecutionRecords(
    ...groups.map((g) => {
      const id = g[0]!.externalId;
      return mergeExecutionRecords(...g.map((r) => [{ ...record(r), id, key: `${r.source}:${id}` }]));
    }),
  );
}

/** Runtime parent_id identifies a subagent, not a session. Resolve only within this root's known lineage. */
export function executionParent(rootId: string, parentSubagentId?: string): string {
  if (!parentSubagentId) return rootId;
  const candidates = getDb()
    .select()
    .from(T)
    .where(and(eq(T.source, "subagent"), eq(T.subagentId, parentSubagentId)))
    .limit(20)
    .all();
  for (const candidate of candidates) {
    if (!candidate.childSessionId) continue;
    let id: string | null = candidate.parentSessionId;
    const seen = new Set<string>();
    while (id && seen.size < 50 && !seen.has(id)) {
      if (id === rootId) return candidate.childSessionId;
      seen.add(id);
      id = getDb().select().from(M).where(eq(M.sessionId, id)).get()?.parentSessionId ?? null;
    }
  }
  return rootId;
}

/** Do not overwrite an existing unrelated session's routing or ownership with transcript claims. */
function inheritChild(parentId: string, childId: string, profile: string | null): boolean {
  if (!validId(childId) || childId === parentId) return false;
  const db = getDb();
  const child = db.select().from(M).where(eq(M.sessionId, childId)).get();
  if (child) return child.parentSessionId === parentId && child.hermesProfile === profile;
  // Prevent cycles, even with malformed persisted lineage.
  const seen = new Set([childId]);
  let current: string | null = parentId;
  let parent: typeof M.$inferSelect | undefined;
  for (let n = 0; current && n < 50; n++) {
    if (seen.has(current)) return false;
    seen.add(current);
    const m = db.select().from(M).where(eq(M.sessionId, current)).get();
    if (current === parentId) parent = m;
    current = m?.parentSessionId ?? null;
  }
  if (current) return false;
  const userId = parent?.userId ?? getOwner()?.id;
  if (!userId) return false;
  db.insert(M).values({ sessionId: childId, userId, parentSessionId: parentId, hermesProfile: profile }).onConflictDoNothing().run();
  markIndexStale(userId);
  return true;
}

export type ExecutionInput = ExecutionRecord & { taskIndex?: number; subagentId?: string; observedCompletion?: boolean };
/** One synchronous transaction; replay is idempotent and a late start never erases a terminal result. */
export function upsertExecution(parentSessionId: string, input: ExecutionInput, profile: string | null): ExecutionRecord {
  return getDb().transaction((db) => {
    const old = db
      .select()
      .from(T)
      .where(
        and(
          eq(T.parentSessionId, parentSessionId),
          eq(T.source, input.source),
          or(
            eq(T.externalId, input.id),
            input.childSessionId ? eq(T.childSessionId, input.childSessionId) : undefined,
            input.subagentId ? eq(T.subagentId, input.subagentId) : undefined,
            input.transcriptPath ? eq(T.transcriptPath, input.transcriptPath) : undefined,
            input.delegationId && input.taskIndex !== undefined ? and(eq(T.delegationId, input.delegationId), eq(T.taskIndex, input.taskIndex)) : undefined,
          ),
        ),
      )
      .get();
    const id = old?.externalId ?? input.id;
    const next = { ...input, id, key: `${input.source}:${id}`, childProfile: profile };
    if (next.childSessionId && !inheritChild(parentSessionId, next.childSessionId, profile)) {
      next.childSessionId = undefined;
      next.href = null;
    }
    const [merged] = mergeExecutionRecords(old ? [record(old)] : [], [next]);
    const r = merged!;
    // A completion with an unrecognised status says nothing about success or continued liveness.
    // Terminal results still win over replayed starts/unknown events.
    if (old && !["completed", "failed", "cancelled"].includes(old.state) && !["completed", "failed", "cancelled"].includes(input.state)) {
      r.state = (input.updatedAt ?? "") >= old.updatedAt && (input.state !== "unknown" || input.observedCompletion) ? input.state : old.state;
      r.updatedAt = (input.updatedAt ?? "") >= old.updatedAt ? input.updatedAt : old.updatedAt;
    }
    const values = {
      parentSessionId,
      source: r.source,
      externalId: id,
      childSessionId: r.childSessionId ?? null,
      childProfile: profile,
      delegationId: r.delegationId ?? null,
      subagentId: input.subagentId ?? old?.subagentId ?? null,
      taskIndex: input.taskIndex ?? old?.taskIndex ?? null,
      title: executionText(r.title, 300) ?? "Execution",
      state: r.state,
      step: executionText(r.step, 500),
      summary: executionText(r.summary),
      error: executionText(r.error, 2048),
      startedAt: r.startedAt ?? null,
      endedAt: r.endedAt ?? null,
      updatedAt: r.updatedAt ?? new Date().toISOString(),
      transcriptPath: executionText(r.transcriptPath, 1024),
      linksJson: JSON.stringify(executionLinks((r.links ?? []).map((l) => l.url).join("\n") + "\n" + (r.summary ?? ""))),
    };
    db.insert(T)
      .values(values)
      .onConflictDoUpdate({ target: [T.parentSessionId, T.source, T.externalId], set: values })
      .run();
    return record(
      db
        .select()
        .from(T)
        .where(and(eq(T.parentSessionId, parentSessionId), eq(T.source, r.source), eq(T.externalId, id)))
        .get()!,
    );
  });
}
