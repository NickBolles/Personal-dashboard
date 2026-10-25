import "server-only";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getPreferences } from "@/server/settings";
import type { UsageDay, UsageResponse } from "@/lib/ai";
import { getAiSettings } from "./settings";
import { localDay, localDayStart, overCap } from "./rules";

/**
 * Spend ledger. The daily budget is household-wide (owner decision: $5/day):
 * spent = Σ (cost_usd ?? estimate_usd) of jobs finished since local midnight;
 * reserved = Σ estimate_usd of jobs running right now.
 */
const J = schema.aiJobs;

export function spendToday(now = new Date()) {
  const tz = getPreferences().timezone;
  const since = localDayStart(now, tz).toISOString();
  const db = getDb();
  const spent = db
    .select({ n: sql<number>`coalesce(sum(coalesce(${J.costUsd}, ${J.estimateUsd})), 0)` })
    .from(J)
    .where(and(gte(J.finishedAt, since), inArray(J.state, ["succeeded", "failed", "cancelled"])))
    .get();
  const reserved = db
    .select({ n: sql<number>`coalesce(sum(${J.estimateUsd}), 0)` })
    .from(J)
    .where(inArray(J.state, ["running", "waiting_approval", "cancelling"]))
    .get();
  return { spentUsd: Number(spent?.n ?? 0), reservedUsd: Number(reserved?.n ?? 0), day: localDay(now, tz) };
}

export function usage(userId: string | null, days: number, now = new Date()): UsageResponse {
  const tz = getPreferences().timezone;
  const settings = getAiSettings();
  const since = new Date(localDayStart(now, tz).getTime() - (days - 1) * 86400_000).toISOString();
  const rows = getDb()
    .select()
    .from(J)
    .where(and(gte(J.finishedAt, since), ...(userId ? [eq(J.userId, userId)] : [])))
    .all();
  const byDay = new Map<string, UsageDay>();
  let overCapCount = 0;
  for (const r of rows) {
    if (!r.finishedAt || !["succeeded", "failed", "cancelled"].includes(r.state)) continue;
    const day = localDay(new Date(r.finishedAt), tz);
    const d = byDay.get(day) ?? { day, jobs: 0, costUsd: 0, byKind: {}, byModel: {} };
    const cost = r.costUsd ?? r.estimateUsd;
    d.jobs++;
    d.costUsd += cost;
    d.byKind[r.kind] = (d.byKind[r.kind] ?? 0) + cost;
    const m = r.model ?? "default";
    d.byModel[m] = (d.byModel[m] ?? 0) + cost;
    byDay.set(day, d);
    if (overCap(r.costUsd, settings.jobCapsUsd[r.tier as "triage" | "standard" | "deep"] ?? 0)) overCapCount++;
  }
  const list = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
  const t = spendToday(now);
  return {
    days: list,
    totals: { jobs: list.reduce((n, d) => n + d.jobs, 0), costUsd: list.reduce((n, d) => n + d.costUsd, 0), overCap: overCapCount },
    today: { spentUsd: t.spentUsd, reservedUsd: t.reservedUsd, budgetUsd: settings.dailyBudgetUsd },
  };
}

export function usageCsv(userId: string | null, days: number) {
  const rows = getDb()
    .select()
    .from(J)
    .where(and(gte(J.createdAt, new Date(Date.now() - days * 86400_000).toISOString()), ...(userId ? [eq(J.userId, userId)] : [])))
    .all();
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["id", "kind", "state", "tier", "model", "estimate_usd", "cost_usd", "cost_source", "error_code", "created_at", "finished_at"];
  return [
    head.join(","),
    ...rows.map((r) =>
      [r.id, r.kind, r.state, r.tier, r.model, r.estimateUsd, r.costUsd, r.costSource, r.errorCode, r.createdAt, r.finishedAt].map(esc).join(","),
    ),
  ].join("\n");
}
