import "server-only";
import fs from "node:fs";
import { z } from "zod";
import { BILLING_LABEL, BILLING_PROVIDER, type AiSettings, type MeterView } from "@/lib/ai";
import { getAiSettings } from "./settings";

/**
 * Subscription usage meter. A Hermes cron (`hermes usage --json`, see
 * deployments/jarvis/hermes-usage-export.sh) writes a snapshot with each
 * provider's weekly-window used %; deploy.sh mounts its directory read-only.
 * Jarvis never calls the provider itself and the file holds no secrets.
 */
export const USAGE_STALE_MS = 2 * 3600_000;
export const usageFile = () => process.env.JARVIS_HERMES_USAGE_FILE || "/hermes-usage/usage.json";

const pct = z.number().min(0).max(1000).nullable();
const usageSchema = z.object({
  fetched_at: z.string(),
  providers: z.record(
    z.string(),
    z.object({
      weekly_used_percent: pct.optional(),
      weekly_resets_at: z.string().nullable().optional(),
      fetched_at: z.string().nullable().optional(),
    }),
  ),
});

type Snapshot = { usedPct: number | null; resetsAt: string | null; fetchedAt: string | null };

function readSnapshot(provider: string): Snapshot | null {
  try {
    const raw = fs.readFileSync(usageFile(), "utf8");
    if (raw.length > 64 * 1024) return null;
    const doc = usageSchema.parse(JSON.parse(raw));
    const p = doc.providers[provider];
    if (!p) return null;
    const fetchedAt = p.fetched_at || doc.fetched_at;
    return {
      usedPct: p.weekly_used_percent ?? null,
      resetsAt: p.weekly_resets_at ?? null,
      fetchedAt: Number.isFinite(Date.parse(fetchedAt)) ? fetchedAt : null,
    };
  } catch {
    return null;
  }
}

const round = (n: number) => Math.round(n);

/** Pure decision (exported for tests). */
export function meterFrom(billing: AiSettings["billing"], snap: Snapshot | null, now = new Date()): MeterView {
  const label = BILLING_LABEL[billing.mode];
  if (billing.mode === "api")
    return {
      mode: "api",
      provider: null,
      label,
      state: "api",
      usedPct: null,
      stopAtPct: billing.stopAtPct,
      resetsAt: null,
      fetchedAt: null,
      backgroundAllowed: true,
      summary: "Daily $ budget",
      warning: null,
    };
  const provider = BILLING_PROVIDER[billing.mode];
  const base = { mode: billing.mode, provider, label, stopAtPct: billing.stopAtPct, resetsAt: snap?.resetsAt ?? null, fetchedAt: snap?.fetchedAt ?? null };
  if (!snap || snap.usedPct == null || !snap.fetchedAt)
    return {
      ...base,
      state: "missing",
      usedPct: null,
      backgroundAllowed: false,
      summary: `${label} usage unknown`,
      warning: `${label} usage can't be read, so background AI is paused.`,
    };
  const age = now.getTime() - Date.parse(snap.fetchedAt);
  const usedPct = snap.usedPct;
  if (age > USAGE_STALE_MS)
    return {
      ...base,
      state: "stale",
      usedPct,
      backgroundAllowed: false,
      summary: `${label} ${round(usedPct)}% of week (stale)`,
      warning: `${label} usage is more than 2 hours old, so background AI is paused.`,
    };
  if (usedPct >= billing.stopAtPct)
    return {
      ...base,
      state: "stop",
      usedPct,
      backgroundAllowed: false,
      summary: `${label} ${round(usedPct)}% of week`,
      warning: `${label} is at ${round(usedPct)}% of this week. Background AI is paused to keep half the week free; chat still works.`,
    };
  return { ...base, state: "ok", usedPct, backgroundAllowed: true, summary: `${label} ${round(usedPct)}% of week`, warning: null };
}

export function subscriptionMeter(now = new Date(), settings = getAiSettings()): MeterView {
  const b = settings.billing;
  return meterFrom(b, b.mode === "api" ? null : readSnapshot(BILLING_PROVIDER[b.mode]), now);
}

/** Error text for a background call stopped by the meter. */
export const meterStopText = (m: MeterView) => m.warning ?? `${m.label} usage limit reached`;
