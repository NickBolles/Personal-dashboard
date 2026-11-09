import "server-only";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/server/db";
import { getOwner, type CurrentUser } from "@/server/auth";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { detectSensitivity } from "@/server/ai/rules";
import { assertOwnerSession } from "./decision-store";
import { recordRunEvent, resolveRun } from "./run-events";
import { runRef } from "@/lib/cw-runs";

/**
 * CW-2 "Resume all" (owner-confirmed in the Running tab): for every interrupted run, one resume prompt goes
 * back to the run's own session. Runs that share a session get ONE prompt listing them (a session takes one
 * turn at a time). The prompt is a new turn through the normal chat run path; a turn still in flight on that
 * session is steered instead. Idempotent per interruption: a second tap reuses the same idempotency key, so
 * nothing is sent twice. The run itself flips back to running when the agent heartbeats (jarvis_run_update).
 */
export const resumeSchema = z.object({
  refs: z
    .array(z.string().regex(/^R-\d{1,9}$/))
    .min(1)
    .max(200),
  confirm: z.literal(true),
});

export type ResumeResult = { ref: string; ok: boolean; sent?: "run" | "steer" | "already"; reason?: string };

type Deps = {
  start: (user: CurrentUser, r: { sessionId: string; input: string; idempotencyKey: string }, cid: string) => Promise<unknown>;
  steer: (user: CurrentUser, runId: string, input: string, cid: string) => Promise<unknown>;
  track: (user: CurrentUser, profile: string | null, sessionId: string, cid: string) => Promise<void>;
};

const TERMINAL_CHAT_RUN = ["completed", "failed", "cancelled", "interrupted"];

export function resumePrompt(runs: { ref: string; title: string }[]) {
  const list = runs.map((r) => `${r.ref} (${r.title.replace(/\s+/g, " ").slice(0, 120)})`).join(", ");
  const one = runs.length === 1;
  return `Resume ${list}: ${one ? "it was" : "they were"} interrupted when this session ended. Pick up where ${one ? "it" : "they"} stopped and mark ${one ? "it" : "each"} running again with jarvis_run_update.`;
}

export async function resumeInterruptedRuns(
  user: CurrentUser,
  refs: string[],
  correlationId: string,
  deps?: Partial<Deps>,
): Promise<{ results: ResumeResult[] }> {
  assertOwnerSession("resume runs");
  if (user.id !== getOwner()?.id) throw new HttpError(403, "owner_only", "Only the owner can resume runs");
  const d: Deps = { ...defaultDeps, ...deps };
  const results: ResumeResult[] = [];
  const bySession = new Map<string, { profile: string; runs: ReturnType<typeof resolveRun>[] }>();
  for (const ref of [...new Set(refs)]) {
    let row;
    try {
      row = resolveRun(user.id, ref);
    } catch {
      results.push({ ref, ok: false, reason: "not_found" });
      continue;
    }
    if (row.state !== "interrupted") {
      results.push({ ref, ok: false, reason: "not_interrupted" });
      continue;
    }
    if (!row.hermesSessionId) {
      results.push({ ref, ok: false, reason: "no_session" });
      continue;
    }
    const g = bySession.get(row.hermesSessionId) ?? { profile: row.profile, runs: [] };
    g.runs.push(row);
    bySession.set(row.hermesSessionId, g);
  }
  const db = getDb();
  for (const [sessionId, group] of bySession) {
    // Claim each interruption BEFORE sending (one transaction): a retry, a double tap or a second device finds
    // the claim and sends nothing, whichever path (new turn or steer) the first request took.
    const claims = db.transaction(
      (tx) => {
        const out: { run: (typeof group.runs)[number]; eventId: string }[] = [];
        for (const r of group.runs) {
          const claim = JSON.stringify({ resumeClaim: r.interruptedAt ?? "" });
          const taken = tx
            .select({ id: schema.runEvents.id })
            .from(schema.runEvents)
            .where(and(eq(schema.runEvents.runId, r.id), eq(schema.runEvents.type, "progress"), eq(schema.runEvents.payloadJson, claim)))
            .get();
          if (taken) results.push({ ref: runRef(r.seq) ?? r.id, ok: true, sent: "already" });
          else
            out.push({
              run: r,
              eventId: recordRunEvent(tx, {
                userId: user.id,
                runId: r.id,
                type: "progress",
                summary: "Resume requested by the owner",
                payload: { resumeClaim: r.interruptedAt ?? "" },
                via: `person:${user.id}`,
              }),
            });
        }
        return out;
      },
      { behavior: "immediate" },
    );
    if (!claims.length) continue;
    const listed = claims.map(({ run: r }) => ({ ref: runRef(r.seq) ?? r.id, title: r.title }));
    let input = resumePrompt(listed);
    // Titles are agent-written: never send credential-looking text to a model.
    if (detectSensitivity(input) === "credentials") input = resumePrompt(listed.map((r) => ({ ref: r.ref, title: "see Jarvis" })));
    const key = `cw-resume:${sessionId}:${claims.map(({ run: r }) => `${r.seq}@${r.interruptedAt ?? ""}`).join(",")}`.slice(0, 255);
    try {
      await d.track(user, group.profile === "default" ? null : group.profile, sessionId, correlationId);
      const live = db
        .select()
        .from(schema.runs)
        .where(and(eq(schema.runs.userId, user.id), eq(schema.runs.sessionId, sessionId), notInArray(schema.runs.status, TERMINAL_CHAT_RUN)))
        .orderBy(desc(schema.runs.startedAt))
        .get();
      let sent: "run" | "steer";
      if (live) {
        await d.steer(user, live.runId, input, correlationId);
        sent = "steer";
      } else {
        await d.start(user, { sessionId, input, idempotencyKey: key.replace(/[^\x21-\x7e]/g, "_") }, correlationId);
        sent = "run";
      }
      for (const r of listed) results.push({ ref: r.ref, ok: true, sent });
    } catch (err) {
      // Nothing went out: release the claims so the owner can try again.
      for (const c of claims) db.delete(schema.runEvents).where(eq(schema.runEvents.id, c.eventId)).run();
      const reason = err instanceof HttpError ? err.code : "send_failed";
      for (const r of listed) results.push({ ref: r.ref, ok: false, reason });
    }
  }
  audit({
    actor: user.id,
    action: "coordinator.resume_all",
    source: "work",
    sourceRecord: results
      .map((r) => r.ref)
      .join(",")
      .slice(0, 200),
    result: results.some((r) => r.ok) ? "ok" : "error",
    correlationId,
    detail: { results },
  });
  return { results };
}

const defaultDeps: Deps = {
  start: async (user, r, cid) => (await import("@/server/assistant")).startRun(user, r, cid),
  steer: async (user, runId, input, cid) => (await import("@/server/assistant")).steerRun(user, runId, input, cid),
  // An agent's own session (made outside Jarvis) is recorded on the run's profile first, so the run goes to
  // the right Hermes profile; sessions Jarvis already tracks keep their profile.
  track: async (user, profile, sessionId, cid) => {
    const { sessionProfile, adoptSession } = await import("@/integrations/hermes/service");
    if (!profile || sessionProfile(sessionId) === profile) return;
    await adoptSession(user, { profile, sessionId }, cid);
  },
};
