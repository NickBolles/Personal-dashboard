import "server-only";
import type { TimelineItem } from "@/lib/hermes";
import { parseNotice } from "@/lib/chat-notices";
import { EXECUTION_LIMIT, executionCompletionState, executionState, upsertExecution, type ExecutionInput } from "./execution-store";

const str = (x: unknown) => (typeof x === "string" ? x : undefined);
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const array = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const terminal = (state: string) => ["completed", "failed", "cancelled"].includes(state);

/** Parse only the already fetched, bounded durable timeline. No runtime calls or filesystem reads. */
export function backfillExecutions(parentId: string, timeline: TimelineItem[], profile: string | null) {
  let parsed = 0;
  const save = (r: ExecutionInput) => {
    if (parsed >= EXECUTION_LIMIT) return;
    upsertExecution(parentId, r, profile);
    parsed++;
  };
  // Prefer recent outcomes if the parsing budget cannot cover the whole window.
  for (const item of timeline.slice(-500).reverse()) {
    if (parsed >= EXECUTION_LIMIT) break;
    if (item.kind === "tool") {
      if (!/(?:^|\.)delegate_task$/.test(item.tool) || !item.detail || item.detail.length > 65536) continue;
      let raw: Record<string, unknown>;
      try {
        raw = obj(JSON.parse(item.detail));
      } catch {
        continue;
      }
      const delegationId = str(raw.delegation_id);
      const results = array(raw.results);
      const ids = array(raw.subagent_ids);
      const paths = array(raw.live_transcripts);
      const goals = array(raw.goals);
      const entries = results.length
        ? results
        : ids.length
          ? ids.map((id, i) => ({
              subagent_id: id,
              task_index: i,
              goal: goals[i],
              status: raw.status === "dispatched" ? "running" : raw.status,
              live_transcript: paths[i],
            }))
          : [raw];
      for (const [i, entry] of entries.slice(0, EXECUTION_LIMIT).entries()) {
        const r = obj(entry);
        const taskIndex = typeof r.task_index === "number" && Number.isSafeInteger(r.task_index) && r.task_index >= 0 ? r.task_index : i;
        const childSessionId = str(r.child_session_id);
        const subagentId = str(r.subagent_id);
        const id =
          subagentId ?? childSessionId ?? (delegationId ? `${delegationId}:${taskIndex}` : results.length ? `tool:${item.id}:${taskIndex}` : undefined);
        if (!id) continue;
        const state = executionState(str(r.status));
        save({
          key: `subagent:${id}`,
          id,
          source: "subagent",
          taskIndex,
          subagentId,
          delegationId,
          observedCompletion: results.length > 0 && !["running", "waiting"].includes(state),
          childSessionId,
          title: str(r.goal) ?? str(goals[taskIndex]) ?? "Delegated task",
          state,
          summary: str(r.summary),
          error: str(r.error),
          transcriptPath: str(r.live_transcript) ?? str(paths[taskIndex]),
          startedAt: item.startedAt,
          endedAt: terminal(state) ? item.at : undefined,
          updatedAt: item.at,
        });
      }
      continue;
    }
    if (item.kind !== "user" && item.kind !== "system") continue;
    // The aggregate notice deliberately has no id. Parse each actual process instead.
    const parts = item.text.slice(0, 65536).split(/\n\n(?=\[IMPORTANT: Background process )/);
    for (const text of parts.slice(0, EXECUTION_LIMIT)) {
      const notice = parseNotice(text);
      if (!notice || !("id" in notice) || !notice.id) continue;
      if (notice.kind === "process") {
        const state = /^\[IMPORTANT: Background process \S+ terminated by /i.test(text)
          ? "cancelled"
          : notice.status === "exit 0"
            ? "completed"
            : /^exit -?\d+$/.test(notice.status)
              ? "failed"
              : notice.status === "running"
                ? "running"
                : "unknown";
        save({
          key: `process:${notice.id}`,
          id: notice.id,
          source: "process",
          title: notice.command ?? notice.title,
          state,
          summary: notice.output,
          error: state === "failed" ? notice.output : undefined,
          transcriptPath: text.match(/^(?:Full live transcript[^:]*|Live transcript|Transcript(?: path)?):\s*(.+)$/im)?.[1],
          endedAt: terminal(state) ? item.at : undefined,
          updatedAt: item.at,
        });
      } else if (notice.kind === "delegation") {
        for (const task of notice.tasks.slice(0, EXECUTION_LIMIT)) {
          // Notice task numbers are human-facing (1-based); runtime task_index is zero-based.
          const taskIndex = task.index - 1;
          const id = `${notice.id}:${taskIndex}`;
          const state = executionCompletionState(task.status);
          save({
            key: `subagent:${id}`,
            id,
            source: "subagent",
            title: task.goal ?? "Delegated task",
            state,
            taskIndex,
            delegationId: notice.id,
            observedCompletion: true,
            summary: task.body,
            error: state === "failed" ? task.body : undefined,
            transcriptPath: task.transcript,
            endedAt: terminal(state) ? item.at : undefined,
            updatedAt: item.at,
          });
        }
      }
    }
  }
  return parsed;
}
