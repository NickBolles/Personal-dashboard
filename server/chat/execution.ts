import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { getSessionDetail, sessionAccess } from "@/server/assistant";
import { assertSessionId, sessionProfile } from "@/integrations/hermes/service";
import { mergeExecutionRecords, type ChatExecutionResponse, type ExecutionRecord, type ExecSourceStatus } from "@/lib/chat-execution";
import { executionRuns } from "@/server/work/agent-runs";
import { backfillExecutions } from "./execution-backfill";
import { syncDelegatedRuns } from "@/server/work/delegated-runs";
import { EXECUTION_LIMIT, executionRecords, executionText } from "./execution-store";

export async function chatExecution(user: CurrentUser, id: string): Promise<ChatExecutionResponse> {
  assertSessionId(id);
  if (!sessionAccess(user, id)) throw new HttpError(404, "session_not_found", "Conversation not found");
  const fetchedAt = new Date().toISOString();
  const sources: ExecSourceStatus[] = [];
  let detail: Awaited<ReturnType<typeof getSessionDetail>> | undefined;
  try {
    detail = await getSessionDetail(user, id);
    backfillExecutions(id, detail.timeline, sessionProfile(id));
    sources.push({
      source: "transcript",
      state: "ok",
      at: fetchedAt,
      detail: "Latest 500 messages; at most 200 execution entries parsed per request. Unnotified processes are not discoverable.",
    });
  } catch (err) {
    // Permission failures found in upstream lineage are not source outages.
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) throw err;
    sources.push({
      source: "transcript",
      state: "unavailable",
      at: fetchedAt,
      detail: "Conversation timeline could not be read; persisted results are retained.",
    });
  }
  const persisted = executionRecords(id).filter((r) => !r.childSessionId || sessionAccess(user, r.childSessionId));
  try {
    // Coordinator parity: sub-agents of a filed conversation become agent runs on its item.
    syncDelegatedRuns(user, id, sessionProfile(id), persisted);
  } catch {
    // best effort: the execution view never fails because of the item mirror
  }
  sources.push({ source: "relations", state: "ok", at: fetchedAt, detail: "Latest 200 persisted execution records; older records remain stored." });
  // No parent-filtered inventory exists in the inspected Hermes API. Do not claim an empty/complete inventory.
  sources.push({
    source: "hermes_children",
    state: detail ? "stale" : "unavailable",
    at: fetchedAt,
    detail: "Known event/transcript relationships only; no full session-list scan or authoritative live child inventory.",
  });
  const forks: ExecutionRecord[] = getDb()
    .select()
    .from(schema.sessionMeta)
    .where(eq(schema.sessionMeta.forkedFromSessionId, id))
    .limit(EXECUTION_LIMIT)
    .all()
    .filter((m) => sessionAccess(user, m.sessionId))
    .map((m) => ({
      key: `fork:${m.sessionId}`,
      id: m.sessionId,
      source: "fork",
      title: executionText(m.titleOverride, 300) ?? "Forked conversation",
      state: "unknown",
      childSessionId: m.sessionId,
      childProfile: m.hermesProfile,
      startedAt: m.createdAt,
      href: `/chat/${encodeURIComponent(m.sessionId)}`,
    }));
  let runs: ReturnType<typeof executionRuns> = { jarvis: [], registered: [] };
  try {
    runs = executionRuns(
      user,
      id,
      persisted.flatMap((r) => (r.childSessionId ? [r.childSessionId] : [])),
    );
    sources.push(
      { source: "jarvis_runs", state: "ok", at: fetchedAt, detail: "Latest 200 chat runs and 200 jobs matched by session identity." },
      { source: "registered_runs", state: "ok", at: fetchedAt, detail: "Latest 200 registrations matched by session identity." },
    );
  } catch {
    sources.push({ source: "jarvis_runs", state: "unavailable", at: fetchedAt }, { source: "registered_runs", state: "unavailable", at: fetchedAt });
  }
  const m = getDb().select().from(schema.sessionMeta).where(eq(schema.sessionMeta.sessionId, id)).get();
  const parentId = m?.parentSessionId ?? m?.forkedFromSessionId ?? detail?.parent?.id;
  const parent =
    parentId && sessionAccess(user, parentId)
      ? {
          id: parentId,
          title: executionText(detail?.parent?.title, 300),
          href: `/chat/${encodeURIComponent(parentId)}`,
        }
      : null;
  return { sessionId: id, parent, records: mergeExecutionRecords(persisted, forks, runs.jarvis, runs.registered), sources, fetchedAt };
}
