import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { can } from "@/server/access";
import type { CurrentUser } from "@/server/auth";
import { adapterContext, cachedSource, scopeResult } from "@/server/sources";
import { isOwnersTask } from "@/lib/task-source";
import { processSingleton } from "@/server/singleton";
import { listItems } from "@/server/work/store";
import { githubGet, resolveGithubToken, type ResolvedToken } from "@/server/work/github";
import { spendToday, usage } from "@/server/ai/budget";
import { subscriptionMeter } from "@/server/ai/meter";
import { getAiSettings } from "@/server/ai/settings";
import { resolveIntegration } from "@/integrations/store";
import { parseLines } from "@/integrations/home-assistant/adapter";
import { addDays, localDate, localMinutes } from "@/lib/time";
import { METRICS, PR_REF, type MetricId } from "@/lib/jarvis-ui/catalog";
import { weekDays } from "@/lib/jarvis-ui/intents";
import type { HydratedRef } from "@/lib/jarvis-ui/types";
import type { CalendarEvent, NextAction } from "@/lib/contracts";
import type { WorkItem } from "@/lib/work";
import { itemExcluded, getSmartSettings } from "./store";

/**
 * Hydrators for the v1.1 refs (spec §12a): `metric:`, `cal:week:` and `pr:`.
 * Every number, check and event here comes from Jarvis data or a read-only
 * GitHub GET, never from the model. Finance has no metrics and Finance items'
 * PRs don't resolve.
 */

type Out = Extract<HydratedRef, { kind: "metric" | "calendar" | "pr" }> | Extract<HydratedRef, { unavailable: string }>;

const DONE = new Set(["settled", "abandoned", "superseded"]);
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "narrow", timeZone: "UTC" });

/** Open todos whose due date has passed (household timezone). */
export function overdueTodos(user: CurrentUser, now = new Date()): NextAction[] {
  if (!can(user, "todos.view")) return [];
  const ctx = adapterContext(now);
  return (scopeResult(user, cachedSource("todos", now))?.data?.actions ?? []).filter((a) => {
    if (a.status !== "open" || !a.dueAt || !isOwnersTask(a)) return false;
    return a.dueIsDate ? localDate(new Date(a.dueAt), ctx.timezone) < ctx.today : new Date(a.dueAt) < now;
  });
}

/** Work items the person owns that a smart surface may show (no conversations, no Finance, not done). */
export function openItems(user: CurrentUser): { items: WorkItem[]; byId: Map<string, WorkItem> } {
  if (!can(user, "work.use")) return { items: [], byId: new Map() };
  const all = listItems(user.id);
  const byId = new Map(all.map((i) => [i.id, i]));
  return {
    items: all.filter((i) => i.kind !== "conversation" && i.kind !== "area" && i.parentId && !i.archived && !DONE.has(i.status) && !itemExcluded(i, byId)),
    byId,
  };
}

export function metric(user: CurrentUser, id: MetricId, now = new Date()): Out {
  const ref = `metric:${id}`;
  const tz = adapterContext(now).timezone;
  const today = localDate(now, tz);
  switch (id) {
    case "ai_spend_today": {
      if (!can(user, "work.ai")) return { ref, unavailable: "forbidden" };
      const meter = subscriptionMeter(now);
      if (meter.mode !== "api") {
        // Subscription billing: the ring shows the weekly window used (Hermes reports $0 per call).
        return {
          ref,
          kind: "metric",
          label: meter.summary,
          value: meter.usedPct == null ? 0 : Math.round(meter.usedPct),
          max: 100,
          unit: "pct",
          note:
            meter.state === "ok"
              ? `background AI stops at ${meter.stopAtPct}%`
              : meter.state === "stop"
                ? "background AI paused · chat still works"
                : "usage unreadable · background AI paused",
          href: "/settings/ai",
        };
      }
      const t = spendToday(now);
      const budget = getAiSettings().dailyBudgetUsd;
      return {
        ref,
        kind: "metric",
        label: "AI today",
        value: Math.round((t.spentUsd + t.reservedUsd) * 100) / 100,
        max: budget,
        unit: "usd",
        note: t.reservedUsd ? `incl. $${t.reservedUsd.toFixed(2)} reserved · household budget` : "household budget",
        href: "/settings/ai",
      };
    }
    case "ai_spend_7d": {
      if (!can(user, "work.ai")) return { ref, unavailable: "forbidden" };
      const days = new Map(usage(null, 7, now).days.map((d) => [d.day, d.costUsd]));
      const series = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6)).map((d) => ({
        label: dayLabel(d),
        value: Math.round((days.get(d) ?? 0) * 100) / 100,
      }));
      const total = series.reduce((n, s) => n + s.value, 0);
      return { ref, kind: "metric", label: "AI spend · 7 d", value: Math.round(total * 100) / 100, unit: "usd", series, note: "from the AI usage ledger" };
    }
    case "items_done_14d": {
      if (!can(user, "work.use")) return { ref, unavailable: "forbidden" };
      const all = listItems(user.id, { includeArchived: true });
      const byId = new Map(all.map((i) => [i.id, i]));
      const counts = new Map<string, number>();
      for (const i of all) {
        if (!i.completedAt || i.kind === "conversation" || itemExcluded(i, byId)) continue;
        const d = localDate(new Date(i.completedAt), tz);
        counts.set(d, (counts.get(d) ?? 0) + 1);
      }
      const series = Array.from({ length: 14 }, (_, i) => addDays(today, i - 13)).map((d) => ({ label: dayLabel(d), value: counts.get(d) ?? 0 }));
      return { ref, kind: "metric", label: "Done · 14 d", value: series.reduce((n, s) => n + s.value, 0), unit: "count", series, note: "work items completed" };
    }
    case "overdue_count": {
      if (!can(user, "todos.view") && !can(user, "work.use")) return { ref, unavailable: "forbidden" };
      const items = openItems(user).items.filter((i) => i.targetDate && i.targetDate < today).length;
      return {
        ref,
        kind: "metric",
        label: "Overdue",
        value: overdueTodos(user, now).length + items,
        unit: "count",
        note: "todos and work items past their date",
      };
    }
  }
}

// --- calendar (fixed events of a planned week) ---

export function calendarConfig() {
  const cfg = resolveIntegration("home_assistant").config as { calendarEntities?: string };
  return { calendars: parseLines(cfg.calendarEntities) };
}

/** Household calendar events this person may see, from the cached Skylight + Home Assistant snapshots. */
export function visibleEvents(user: CurrentUser, now = new Date()): CalendarEvent[] {
  return (["skylight", "home_assistant"] as const).flatMap((s) => scopeResult(user, cachedSource(s, now))?.data?.events ?? []);
}

export function calendarWeek(user: CurrentUser, ref: string, now = new Date()): Out {
  const m = ref.match(/^cal:week:(\d{4}-\d{2}-\d{2}):(5|7)$/);
  if (!m) return { ref, unavailable: "unknown" };
  const days = new Set(weekDays(m[1]!, Number(m[2]) as 5 | 7));
  const tz = adapterContext(now).timezone;
  const hhmm = (at: string) => {
    const mins = localMinutes(new Date(at), tz);
    return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  };
  const events = visibleEvents(user, now)
    .flatMap((e): { id: string; title: string; day: string; allDay: boolean; start?: string; end?: string }[] => {
      const base = { id: e.id.slice(0, 200), title: e.title.slice(0, 200) };
      if (e.allDay) return [{ ...base, day: e.startsAt.slice(0, 10), allDay: true }];
      const day = localDate(new Date(e.startsAt), tz);
      const endDay = e.endsAt ? localDate(new Date(e.endsAt), tz) : day;
      const end = e.endsAt ? hhmm(e.endsAt) : undefined;
      if (endDay <= day) return [{ ...base, day, allDay: false, start: hhmm(e.startsAt), ...(end ? { end } : {}) }];
      // Timed events that cross midnight occupy every day they touch: clip one interval per day.
      const out = [{ ...base, day, allDay: false, start: hhmm(e.startsAt), end: "23:59" }];
      for (let d = addDays(day, 1); d <= endDay && out.length < 8; d = addDays(d, 1)) {
        if (d === endDay && end === "00:00") break;
        out.push({ ...base, id: `${base.id}:${d}`.slice(0, 200), day: d, allDay: false, start: "00:00", end: d === endDay ? end! : "23:59" });
      }
      return out;
    })
    .filter((e) => days.has(e.day))
    .sort((a, b) => (a.day + (a.start ?? "") < b.day + (b.start ?? "") ? -1 : 1))
    .slice(0, 100);
  const writable = getSmartSettings(user.id).calendarWrites && calendarConfig().calendars.length > 0 && can(user, "home_assistant.calendar");
  return { ref, kind: "calendar", events, writable };
}

// --- pull requests ---

type PrData = Omit<Extract<HydratedRef, { kind: "pr" }>, "ref" | "itemHref">;
const prCache = () => processSingleton<Map<string, { at: number; data: PrData }>>("smart_pr_cache", () => new Map());
const PR_TTL_MS = 60_000;

function parsePr(ref: string) {
  if (!PR_REF.test(ref)) return null;
  const m = ref.match(/^pr:([^/]+)\/([^#]+)#(\d+)$/)!;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

/** The person's own item that links this PR (a PR ref resolves only through one). */
function linkedItem(user: CurrentUser, target: string) {
  const rows = getDb()
    .select({ itemId: schema.workLinks.itemId })
    .from(schema.workLinks)
    .innerJoin(schema.workItems, eq(schema.workItems.id, schema.workLinks.itemId))
    .where(
      and(eq(schema.workLinks.kind, "github_pr"), sql`lower(${schema.workLinks.targetId}) = ${target.toLowerCase()}`, eq(schema.workItems.userId, user.id)),
    )
    .all();
  return rows.map((r) => r.itemId);
}

const asObj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const asArr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const s = (v: unknown, n = 200) => (typeof v === "string" ? v.slice(0, n) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function checkState(status: unknown, conclusion: unknown): "pass" | "fail" | "pending" | "skipped" {
  if (status !== "completed") return "pending";
  if (conclusion === "success" || conclusion === "neutral") return "pass";
  if (conclusion === "skipped") return "skipped";
  return "fail";
}

/** Readiness from GitHub's own answers: checks, reviews, mergeability, draft. */
export function readiness(d: Pick<PrData, "checks" | "reviews" | "mergeable" | "draft" | "state">): PrData["readiness"] {
  const blockers: string[] = [];
  const failing = d.checks.filter((c) => c.state === "fail").length;
  const running = d.checks.filter((c) => c.state === "pending").length;
  if (!d.checks.length) blockers.push("No checks reported");
  else if (failing) blockers.push(`${failing} failing ${failing === 1 ? "check" : "checks"}`);
  else if (running) blockers.push(`${running} ${running === 1 ? "check" : "checks"} running`);
  const changes = d.reviews.filter((r) => r.state === "changes_requested");
  if (changes.length) blockers.push(`Changes requested by ${changes.map((r) => r.who).join(", ")}`);
  else if (!d.reviews.some((r) => r.state === "approved")) blockers.push("No approving review");
  if (d.mergeable === false) blockers.push("Merge conflicts");
  else if (d.mergeable === null && d.state === "open") blockers.push("GitHub is still checking for conflicts");
  if (d.draft) blockers.push("Draft");
  return { done: 4 - blockers.length, total: 4, blockers };
}

async function fetchPr(p: { owner: string; repo: string; number: number }, auth: ResolvedToken): Promise<PrData> {
  const base = `/repos/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}`;
  const pr = await githubGet(`${base}/pulls/${p.number}`, auth);
  if (pr.status === 404) throw Object.assign(new Error("GitHub couldn't find that pull request"), { code: "unknown" });
  if (pr.status < 200 || pr.status >= 300) throw Object.assign(new Error(`GitHub answered ${pr.status}`), { code: "error" });
  const b = asObj(pr.body) ?? {};
  const sha = s(asObj(b.head)?.sha, 64);
  const okSha = sha && /^[0-9a-f]{7,64}$/i.test(sha);
  const safe = (path: string) => githubGet(path, auth).catch(() => ({ status: 0, headers: new Headers(), body: null }));
  const [runs, status, reviews, comments] = await Promise.all([
    okSha ? safe(`${base}/commits/${sha}/check-runs?per_page=100`) : Promise.resolve(null),
    okSha ? safe(`${base}/commits/${sha}/status`) : Promise.resolve(null),
    safe(`${base}/pulls/${p.number}/reviews?per_page=100`),
    safe(`${base}/pulls/${p.number}/comments?per_page=100`),
  ]);
  const checks: PrData["checks"] = [];
  if (runs?.status === 200)
    for (const r of asArr(asObj(runs.body)?.check_runs))
      checks.push({
        name: s(r.name, 120) ?? "check",
        state: checkState(r.status, r.conclusion),
        ...(s(r.conclusion, 40) ? { detail: s(r.conclusion, 40) } : {}),
      });
  if (status?.status === 200)
    for (const st of asArr(asObj(status.body)?.statuses)) {
      const state = st.state === "success" ? "pass" : st.state === "pending" ? "pending" : "fail";
      checks.push({ name: s(st.context, 120) ?? "status", state, ...(s(st.description, 120) ? { detail: s(st.description, 120) } : {}) });
    }
  // A check source GitHub didn't return may hold failing or running checks: keep readiness pending.
  if (okSha && (runs?.status !== 200 || status?.status !== 200))
    checks.push({ name: "Checks on GitHub", state: "pending", detail: "Couldn't load every check" });
  // More check runs than one page returned: readiness can't be complete, so keep it pending.
  const totalRuns = runs?.status === 200 ? num(asObj(runs.body)?.total_count) : undefined;
  if (totalRuns !== undefined && totalRuns > asArr(asObj(runs?.body)?.check_runs).length)
    checks.push({ name: "More checks on GitHub", state: "pending", detail: `${totalRuns} in total` });
  // Latest review per reviewer decides; comments don't override an approval.
  const latest = new Map<string, PrData["reviews"][number]["state"]>();
  if (reviews.status === 200)
    for (const r of asArr(reviews.body)) {
      const who = s(asObj(r.user)?.login, 80);
      const st = r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes_requested" : r.state === "COMMENTED" ? "commented" : null;
      if (!who || !st) continue;
      if (st === "commented" && latest.has(who)) continue;
      latest.set(who, st);
    }
  const codexFindings =
    comments.status === 200 ? asArr(comments.body).filter((c) => /codex/i.test(s(asObj(c.user)?.login, 80) ?? "") && c.in_reply_to_id == null).length : null;
  const merged = b.merged === true || Boolean(s(b.merged_at));
  const data: Omit<PrData, "readiness"> = {
    kind: "pr",
    title: s(b.title) ?? `#${p.number}`,
    repo: `${p.owner}/${p.repo}`,
    number: p.number,
    state: merged ? "merged" : b.state === "closed" ? "closed" : "open",
    draft: b.draft === true,
    url: `https://github.com/${p.owner}/${p.repo}/pull/${p.number}`,
    headRef: s(asObj(b.head)?.ref, 120),
    baseRef: s(asObj(b.base)?.ref, 120),
    additions: num(b.additions),
    deletions: num(b.deletions),
    files: num(b.changed_files),
    updatedAt: s(b.updated_at, 40),
    checks,
    reviews: [...latest.entries()].map(([who, state]) => ({ who, state })),
    mergeable: typeof b.mergeable === "boolean" ? b.mergeable : null,
    mergeableState: s(b.mergeable_state, 40),
    codexFindings,
  };
  // Readiness counts every returned check; only the displayed list is trimmed (blockers first).
  const ready = readiness(data);
  const rank = { fail: 0, pending: 1, pass: 2, skipped: 3 } as Record<string, number>;
  const shown = checks.length <= 100 ? checks : [...checks].sort((x, y) => (rank[x.state] ?? 4) - (rank[y.state] ?? 4)).slice(0, 100);
  return { ...data, checks: shown, readiness: ready };
}

export async function pullRequest(user: CurrentUser, ref: string, now = Date.now()): Promise<Out> {
  if (!can(user, "work.use")) return { ref, unavailable: "forbidden" };
  const p = parsePr(ref);
  if (!p) return { ref, unavailable: "unknown" };
  const items = linkedItem(user, `${p.owner}/${p.repo}#${p.number}`);
  if (!items.length) return { ref, unavailable: "unknown" };
  const all = listItems(user.id, { includeArchived: true });
  const byId = new Map(all.map((i) => [i.id, i]));
  const item = items.map((id) => byId.get(id)).find((i) => i && !itemExcluded(i, byId));
  if (!item) return { ref, unavailable: "finance" };
  const itemHref = `/areas?item=${encodeURIComponent(item.id)}`;
  const key = ref.toLowerCase();
  const hit = prCache().get(key);
  if (hit && now - hit.at < PR_TTL_MS) return { ref, ...hit.data, itemHref };
  const auth = await resolveGithubToken(p.owner, p.repo);
  if (!auth) return { ref, unavailable: "not_connected", message: "Connect GitHub (Settings → Connections) to see checks and reviews" };
  try {
    const data = await fetchPr(p, auth);
    prCache().set(key, { at: now, data });
    return { ref, ...data, itemHref };
  } catch (e) {
    const code = (e as { code?: string }).code === "unknown" ? "unknown" : "error";
    return { ref, unavailable: code, message: (e as Error).message.slice(0, 200) };
  }
}

export function __resetPrCache() {
  prCache().clear();
}

export function isMetric(id: string): id is MetricId {
  return (METRICS as readonly string[]).includes(id);
}
