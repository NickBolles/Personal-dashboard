import { api } from "@/server/http/api";
import { adapterContext } from "@/server/sources";
import { compassPrompt, compassState, recordCompassSession } from "@/integrations/daily-compass/adapter";
import { createSession, startRun } from "@/integrations/hermes/service";

/** Starts (or resumes) today's check-in as a Hermes conversation. */
export const POST = api(async ({ user, correlationId }) => {
  const ctx = adapterContext();
  const state = await compassState(ctx);
  if (state.sessionId) return { sessionId: state.sessionId, resumed: true };
  const session = await createSession(user, `Daily Compass · ${ctx.today}`);
  recordCompassSession(ctx.today, session.id);
  const run = await startRun(
    user,
    { sessionId: session.id, input: compassPrompt() || "Let's do my Daily Compass check-in.", idempotencyKey: `compass-${ctx.today}-${session.id}` },
    correlationId,
  );
  return { sessionId: session.id, runId: run.runId, resumed: false };
});
