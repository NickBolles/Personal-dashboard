import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { MINUTE } from "@/lib/time";
import { runChecks } from "@/integrations/testing";
import { baseAction } from "@/integrations/actions";
import type { SourceAdapter } from "@/integrations/types";
import { hermesConn, HermesDiscoveryClient, HermesSessionClient } from "./client";

const STALE = 2 * MINUTE;

export const hermesAdapter: SourceAdapter = {
  source: "hermes",
  staleAfterMs: STALE,
  async fetch(ctx) {
    // Health gate: an unreachable Hermes must show as an error, not as "nothing waiting".
    await HermesDiscoveryClient.health(hermesConn());
    const waiting = getDb().select().from(schema.runs).where(eq(schema.runs.status, "waiting_for_approval")).all();
    const actions = waiting.map((r) => {
      const approval = r.pendingApproval ? (JSON.parse(r.pendingApproval) as { description?: string; command?: string }) : {};
      return baseAction("hermes", r.runId, ctx, STALE, {
        title: `Hermes needs approval: ${approval.description ?? "a pending action"}`,
        detail: approval.command ? `Command: ${approval.command}` : (r.inputPreview ?? undefined),
        status: "open",
        priorityReason: "awaiting_user",
        updatedAt: r.lastCheckedAt ?? r.startedAt,
        href: `/chat/${encodeURIComponent(r.sessionId)}`,
        primaryAction: { kind: "open", label: "Review" },
      });
    });
    return { actions };
  },
  async test() {
    let version = "";
    return runChecks([
      {
        name: "Reach API server",
        run: async () => {
          const h = await HermesDiscoveryClient.health(hermesConn());
          version = h.version ?? "";
          return `${h.platform ?? "hermes"} ${version}`.trim();
        },
      },
      {
        name: "Authenticate + capabilities",
        run: async () => {
          const caps = await HermesDiscoveryClient.capabilities(hermesConn());
          const need = ["run_submission", "run_events_sse", "run_stop", "session_fork"];
          const missing = need.filter((f) => !caps.features[f]);
          if (missing.length) throw new Error(`Missing features: ${missing.join(", ")}`);
          const approvals = caps.features.run_approval_response ? "approvals" : "no approvals";
          return `Runs, streaming, stop, fork, ${approvals}`;
        },
      },
      {
        name: "List sessions",
        run: async () => {
          const s = await HermesSessionClient.list(hermesConn(), { limit: 5 });
          return `${s.data.length}${s.has_more ? "+" : ""} recent sessions`;
        },
      },
    ]);
  },
};
