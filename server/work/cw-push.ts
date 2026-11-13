import "server-only";
import { and, eq, gt, inArray } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getOwner } from "@/server/auth";
import { notify } from "@/server/notifications";
import { kickDispatcher } from "@/server/notifications/dispatcher";
import { getSetting, setSetting } from "@/server/settings";
import { detectSensitivity } from "@/server/ai/rules";
import { maskAccountNumbers } from "@/lib/ai-redact";
import { decisionRef, parsePack, parseRisk } from "@/lib/cw-decisions";
import { runRef } from "@/lib/cw-runs";
import { coordLink } from "@/lib/coordinator/links";

/**
 * CW-5 (owner-approved): what interrupts the owner. Failed runs, ended sessions (interrupted runs)
 * and urgent/blocking decisions (risk-flagged, or the pack says it unblocks something) push at once;
 * every other new decision is batched into one digest every 2 hours. Goes through the existing
 * notifications inbox + push dispatcher (category prefs and quiet hours apply). A LOW-RISK decision push
 * gets one-tap answers at delivery (cw-push-actions.ts, Undo after); a risk-flagged one only deep-links to
 * the decision detail (Confirm in the app). The deep link opens the decision/run in the coordinator sheet or rail.
 */
export const DIGEST_EVERY_MS = 2 * 3_600_000;
const DIGEST_KEY = (userId: string) => `cw:digest-at:${userId}`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Push bodies leave Jarvis (push services): credential-like text is never sent, account numbers are masked. */
function safeText(text: string, fallback: string) {
  if (detectSensitivity(text) === "credentials") return fallback;
  return clip(maskAccountNumbers(text.replace(/\s+/g, " ").trim()), 180);
}

type DecisionRow = typeof schema.decisions.$inferSelect;

export function isUrgentDecision(d: Pick<DecisionRow, "riskJson" | "packJson">) {
  return parseRisk(d.riskJson).length > 0 || (parsePack(d.packJson).unblocks?.length ?? 0) > 0;
}

/** Called after a decision is raised (outside the raise transaction). Urgent ones push now. */
export function pushRaisedDecision(d: DecisionRow) {
  if (!isUrgentDecision(d)) return;
  const ref = decisionRef(d.seq);
  const risky = parseRisk(d.riskJson).length > 0;
  notify(
    {
      type: "cw.decision",
      category: "hermes_input",
      severity: risky ? "high" : "normal",
      title: `${ref} needs you`,
      // A credential-flagged question is never sent to a push service, even when it looks harmless.
      body: parseRisk(d.riskJson).includes("credential") ? "Open Jarvis to see the question." : safeText(d.question, "Open Jarvis to see the question."),
      source: "jarvis",
      deepLink: coordLink({ coord: "needs", d: ref }),
      dedupeKey: `cw:decision:${ref}`,
    },
    d.userId,
  );
  kickDispatcher();
}

type RunRow = typeof schema.agentRuns.$inferSelect;

/** Called on a run's transition to failed or interrupted (session ended). */
export function pushRunTransition(run: Pick<RunRow, "userId" | "seq" | "title" | "itemId">, state: "failed" | "interrupted") {
  const ref = runRef(run.seq);
  if (!ref) return;
  if (state === "failed")
    notify(
      {
        type: "cw.run_failed",
        category: "hermes_complete",
        severity: "high",
        title: `${ref} failed`,
        body: safeText(run.title, "A run failed."),
        source: "jarvis",
        deepLink: coordLink({ coord: "running", r: ref }),
        dedupeKey: `cw:run-failed:${ref}`,
      },
      run.userId,
    );
  else {
    // One push per ended session burst: the dedupe key is per hour, the count updates in place.
    const interrupted = getDb()
      .select({ id: schema.agentRuns.id })
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.userId, run.userId), eq(schema.agentRuns.state, "interrupted")))
      .all().length;
    notify(
      {
        type: "cw.session_ended",
        category: "hermes_complete",
        severity: "high",
        title: `Session ended · ${interrupted} ${interrupted === 1 ? "run" : "runs"} stopped`,
        body: `Resume all ${interrupted} from Activity.`,
        source: "jarvis",
        deepLink: coordLink({ coord: "running", f: "interrupted" }),
        dedupeKey: `cw:interrupted:${new Date().toISOString().slice(0, 13)}`,
      },
      run.userId,
    );
  }
  kickDispatcher();
}

/** Dispatcher task: one digest of the non-urgent decisions raised since the last digest (every 2 h). */
export function decisionDigest(now = new Date()) {
  const owner = getOwner();
  if (!owner) return { sent: 0 };
  const last = getSetting<string>(DIGEST_KEY(owner.id));
  if (last && now.getTime() - Date.parse(last) < DIGEST_EVERY_MS) return { sent: 0 };
  const since = last ?? new Date(now.getTime() - DIGEST_EVERY_MS).toISOString();
  const rows = getDb()
    .select()
    .from(schema.decisions)
    .where(and(eq(schema.decisions.userId, owner.id), inArray(schema.decisions.state, ["open"]), gt(schema.decisions.createdAt, since)))
    .all()
    .filter((d) => !isUrgentDecision(d));
  setSetting(DIGEST_KEY(owner.id), now.toISOString());
  if (!rows.length) return { sent: 0 };
  const refs = rows.map((d) => decisionRef(d.seq));
  notify(
    {
      type: "cw.decision_digest",
      category: "hermes_input",
      severity: "normal",
      title: `${rows.length} new ${rows.length === 1 ? "decision" : "decisions"} in Needs you`,
      body: clip(refs.join(", "), 180),
      source: "jarvis",
      deepLink: coordLink({ coord: "needs" }),
      dedupeKey: `cw:digest:${now.toISOString().slice(0, 13)}`,
    },
    owner.id,
  );
  kickDispatcher();
  return { sent: rows.length };
}
