import { api } from "@/server/http/api";
import { adapterContext } from "@/server/sources";
import { compassPrompt, compassSessionId, recordCompassSession } from "@/integrations/daily-compass/adapter";
import { createSession, startRun } from "@/integrations/hermes/service";

/** Starts (or resumes) today's check-in as a Hermes conversation. */
export const POST = api(
  async ({ user, correlationId }) => {
    const ctx = adapterContext();
    // Local lookup only: starting a check-in must not wait on a Hermes status sync.
    const existing = compassSessionId(ctx.today);
    if (existing) return { sessionId: existing, resumed: true };
    const session = await createSession(user, `Daily Compass · ${ctx.today}`);
    recordCompassSession(ctx.today, session.id);
    const run = await startRun(
      user,
      { sessionId: session.id, input: compassPrompt() || "Let's do my Daily Compass check-in.", idempotencyKey: `compass-${ctx.today}-${session.id}` },
      correlationId,
    );
    return { sessionId: session.id, runId: run.runId, resumed: false };
  },
  { cap: "daily_compass.use" },
);
