import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { audit } from "@/server/audit";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";
import { ensureRunSeqs, nextRunSeq, recordRunEvent, recordRunTransition, resolveRun } from "./run-events";
import { runRef } from "@/lib/cw-runs";
import type { AgentRunState } from "@/lib/agent-runs";

/** Shared persistence for MCP delegations and server-owned scheduled coordinator runs. */
export function registerAgentRun(
  user: CurrentUser,
  profile: string,
  input: { itemId: string; title: string; hermesSessionId?: string; delegationId?: string; transcriptPath?: string; parentRunId?: string },
  correlationId: string,
  tokenId: string | null = null,
  now = new Date(),
) {
  const db = getDb();
  ensureRunSeqs(user.id);
  const parentRunId = input.parentRunId ? resolveRun(user.id, input.parentRunId).id : null;
  const result = db.transaction(
    (tx) => {
      if (input.delegationId) {
        const prior = tx
          .select()
          .from(schema.agentRuns)
          .where(and(eq(schema.agentRuns.userId, user.id), eq(schema.agentRuns.profile, profile), eq(schema.agentRuns.delegationId, input.delegationId)))
          .get();
        if (prior) {
          if (prior.itemId !== input.itemId) throw new HttpError(409, "delegation_taken", "That delegationId is already registered on another item");
          return { runId: prior.id, ref: runRef(prior.seq)!, existing: true };
        }
      }
      const runId = newId("arun");
      const at = now.toISOString();
      const seq = nextRunSeq(tx, user.id);
      tx.insert(schema.agentRuns)
        .values({
          id: runId,
          seq,
          parentRunId,
          userId: user.id,
          itemId: input.itemId,
          tokenId,
          profile,
          title: input.title,
          state: "running",
          hermesSessionId: input.hermesSessionId ?? null,
          delegationId: input.delegationId ?? null,
          transcriptPath: input.transcriptPath ?? null,
          startedAt: at,
          updatedAt: at,
        })
        .run();
      recordRunEvent(tx, { userId: user.id, runId, type: "started", summary: input.title.slice(0, 300), via: `agent:${profile}` });
      tx.insert(schema.workEvents)
        .values({
          id: newId(),
          itemId: input.itemId,
          actor: user.id,
          kind: "agent_run",
          reason: `started agent run: ${input.title}`,
          via: `agent:${profile}`,
          at,
        })
        .run();
      return { runId, ref: runRef(seq)! };
    },
    { behavior: "immediate" },
  );
  if ("existing" in result) return result;
  audit({
    actor: `agent:${profile}`,
    action: "agent.run_start",
    source: "agent",
    sourceRecord: result.runId,
    result: "ok",
    correlationId,
    detail: { itemId: input.itemId },
  });
  return result;
}
export function finishRegisteredRun(user: CurrentUser, id: string, state: AgentRunState, summary: string, now: Date) {
  const db = getDb();
  db.transaction(
    (tx) => {
      const row = tx
        .select()
        .from(schema.agentRuns)
        .where(and(eq(schema.agentRuns.id, id), eq(schema.agentRuns.userId, user.id)))
        .get();
      if (!row) return;
      const terminal = state === "done" || state === "failed";
      tx.update(schema.agentRuns)
        .set({
          state,
          summary,
          updatedAt: now.toISOString(),
          finishedAt: terminal ? now.toISOString() : null,
          interruptedAt: state === "interrupted" ? (row.interruptedAt ?? now.toISOString()) : null,
        })
        .where(eq(schema.agentRuns.id, id))
        .run();
      if (terminal && row.state !== state)
        tx.insert(schema.workEvents)
          .values({
            id: newId(),
            itemId: row.itemId,
            actor: user.id,
            kind: "agent_run",
            reason: `agent run ${state === "done" ? "finished" : "failed"}: ${row.title}`,
            via: `agent:${row.profile}`,
            at: now.toISOString(),
          })
          .run();
      recordRunTransition(tx, row, state, summary, `agent:${row.profile}`);
    },
    { behavior: "immediate" },
  );
}
