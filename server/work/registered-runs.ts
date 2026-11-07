import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId } from "@/server/crypto";
import { audit } from "@/server/audit";
import type { CurrentUser } from "@/server/auth";
import { HttpError } from "@/server/http/errors";

/** Shared persistence for MCP delegations and server-owned scheduled coordinator runs. */
export function registerAgentRun(
  user: CurrentUser,
  profile: string,
  input: { itemId: string; title: string; hermesSessionId?: string; delegationId?: string; transcriptPath?: string },
  correlationId: string,
  tokenId: string | null = null,
  now = new Date(),
) {
  const db = getDb();
  if (input.delegationId) {
    const prior = db
      .select()
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.userId, user.id), eq(schema.agentRuns.profile, profile), eq(schema.agentRuns.delegationId, input.delegationId)))
      .get();
    if (prior) {
      if (prior.itemId !== input.itemId) throw new HttpError(409, "delegation_taken", "That delegationId is already registered on another item");
      return { runId: prior.id, existing: true };
    }
  }
  const runId = newId("arun");
  const at = now.toISOString();
  db.transaction((tx) => {
    tx.insert(schema.agentRuns)
      .values({
        id: runId,
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
  });
  audit({
    actor: `agent:${profile}`,
    action: "agent.run_start",
    source: "agent",
    sourceRecord: runId,
    result: "ok",
    correlationId,
    detail: { itemId: input.itemId },
  });
  return { runId };
}
export function finishRegisteredRun(user: CurrentUser, id: string, state: "running" | "waiting" | "done" | "failed", summary: string, now: Date) {
  const db = getDb();
  const row = db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.id, id), eq(schema.agentRuns.userId, user.id)))
    .get();
  if (!row) return;
  const terminal = state === "done" || state === "failed";
  db.update(schema.agentRuns)
    .set({ state, summary, updatedAt: now.toISOString(), finishedAt: terminal ? now.toISOString() : null })
    .where(eq(schema.agentRuns.id, id))
    .run();
  if (terminal && row.state !== state)
    db.insert(schema.workEvents)
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
}
