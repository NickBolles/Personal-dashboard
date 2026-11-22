import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AGENT_MOMENTS, MOMENT_MAX, RUN_EVENT_TYPES, SYSTEM_RUN_EVENTS, lockSchema, pipelineSchema, runRef } from "@/lib/cw-runs";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { ensureRunSeqs, recordRunEvent, resolveRun, runIdentifier } from "@/server/work/run-events";
import { LOG_TAIL_MAX, TASK_INDEX_MAX, parseTranscriptPath, readSubagentLog } from "@/server/chat/subagent-log";
import { visible, type ToolDef } from "./tools";

// Local generic helper avoids evaluating the tools.ts registry during its own initialization.
const tool = <S extends z.ZodType>(t: ToolDef<S>) => t as unknown as ToolDef;
const AGENT_EVENTS = RUN_EVENT_TYPES.filter((t) => !SYSTEM_RUN_EVENTS.includes(t));

export const RUN_TOOLS: ToolDef[] = [
  tool({
    name: "jarvis_run_event",
    description:
      'Append a structured event to your own run (id or R-n): progress, notice, lock.acquired/lock.released, ci, release.staged/release.live. Every event is a heartbeat. Call this instead of replying in chat when a background notice changes nothing for the owner. Use type "notice" to fold that completion into the run card, without an Activity/chat post. payload.lock sets the acquired lock; release clears it. CI/release payload.pipeline updates pipeline chips. System lifecycle events are reserved for run_start/run_update.',
    scope: "runs.write",
    input: z
      .object({
        runId: runIdentifier,
        type: z.enum(AGENT_EVENTS),
        summary: z.string().trim().max(300),
        /** A key moment of the task (with type "progress"): what you found, made, are blocked on or handed off. One line, 140 characters at most. */
        moment: z.enum(AGENT_MOMENTS).optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    run: ({ runId, type, summary, moment, payload: given }, { agent, correlationId }) => {
      if (moment && type !== "progress") throw new HttpError(400, "moment", 'A moment goes on a "progress" event');
      if (moment && (summary.length > MOMENT_MAX || /[\r\n]/.test(summary) || !summary))
        throw new HttpError(400, "moment", `A moment is one line of at most ${MOMENT_MAX} characters`);
      const payload: Record<string, unknown> | undefined = moment ? { ...(given ?? {}), moment } : given;
      ensureRunSeqs(agent.user.id);
      const db = getDb();
      const result = db.transaction(
        (tx) => {
          const run = resolveRun(agent.user.id, runId, tx);
          if (run.profile !== agent.profile) throw new HttpError(404, "not_found", "No run with that id for this agent");
          visible(agent.user.id, run.itemId);
          // Defend the invariant even for callers that invoke the definition without parsing its input.
          if (SYSTEM_RUN_EVENTS.includes(type)) throw new HttpError(400, "system_event", "Use run_start/run_update for lifecycle events");
          const eventId = recordRunEvent(tx, { userId: agent.user.id, runId: run.id, type, summary, payload, via: agent.via });
          const lock = type === "lock.acquired" ? lockSchema.parse(payload?.lock ?? payload) : undefined;
          const pipeline =
            (type === "ci" || type.startsWith("release.")) && payload?.pipeline !== undefined ? pipelineSchema.parse(payload.pipeline) : undefined;
          tx.update(schema.agentRuns)
            .set({
              updatedAt: new Date().toISOString(),
              ...(lock ? { lockJson: JSON.stringify(lock) } : {}),
              ...(type === "lock.released" ? { lockJson: null } : {}),
              ...(pipeline !== undefined ? { pipelineJson: JSON.stringify(pipeline) } : {}),
            })
            .where(eq(schema.agentRuns.id, run.id))
            .run();
          return { eventId, runRef: runRef(run.seq)! };
        },
        { behavior: "immediate" },
      );
      audit({ actor: agent.via, action: "agent.run_event", source: "agent", sourceRecord: result.eventId, result: "ok", correlationId, detail: { type } });
      return result;
    },
  }),
  tool({
    name: "jarvis_read_subagent_log",
    description:
      "Read the tail of one of YOUR OWN delegated sub-agents' live transcript logs (read-only). Pass `path` (the transcriptPath Hermes reported, e.g. …/cache/delegation/live/deleg_1a2b3c4d/task-0.log) or `delegationId` + `task`. `tail` = bytes from the end (default 64 KB, max 256 KB). Credentials are masked. Returns {profile, delegationId, task, size, bytes, truncated, modifiedAt, masked, text}.",
    scope: "runs.write",
    input: z
      .object({
        path: z.string().max(1024).optional(),
        delegationId: z.string().max(40).optional(),
        task: z.number().int().min(0).max(TASK_INDEX_MAX).optional(),
        tail: z.number().int().min(1).max(LOG_TAIL_MAX).optional(),
      })
      .strict(),
    run: ({ path, delegationId, task, tail }, { agent, correlationId }) => {
      const ref = path !== undefined ? parseTranscriptPath(path) : { profile: agent.profile, delegationId, task };
      if (!ref) throw new HttpError(400, "bad_path", "That isn't a sub-agent transcript path");
      // Own profile only: another agent's sub-agents are not yours to read.
      if (ref.profile !== agent.profile) throw new HttpError(404, "not_found", "No log for that sub-agent");
      const log = readSubagentLog(ref, tail);
      audit({
        actor: agent.via,
        action: "agent.read_subagent_log",
        source: "agent",
        sourceRecord: `${log.delegationId}/task-${log.task}`,
        result: "ok",
        correlationId,
        detail: { bytes: log.bytes, truncated: log.truncated },
      });
      return log;
    },
  }),
];
