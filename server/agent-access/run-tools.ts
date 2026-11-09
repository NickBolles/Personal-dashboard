import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { RUN_EVENT_TYPES, SYSTEM_RUN_EVENTS, lockSchema, pipelineSchema, runRef } from "@/lib/cw-runs";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { ensureRunSeqs, recordRunEvent, resolveRun, runIdentifier } from "@/server/work/run-events";
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
        payload: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    run: ({ runId, type, summary, payload }, { agent, correlationId }) => {
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
];
