import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  backoffMs,
  budgetGate,
  canTransition,
  captureFollowUp,
  detectSensitivity,
  effectiveAreaPolicy,
  financeGuard,
  laneFor,
  localDay,
  localDayStart,
  overCap,
  retryable,
  shouldInvestigate,
  tierFor,
  visibleFor,
} from "@/server/ai/rules";
import { findSlots, zonedToUtc } from "@/server/ai/schedule";
import { JOB_STATES, DEFAULT_AI_SETTINGS, OUTPUT_SCHEMAS, aiSettingsSchema, type JobState } from "@/lib/ai";
import { parseAreaSettings } from "@/lib/work";

describe("ai rules (pure)", () => {
  it("allows exactly the documented transitions", () => {
    const allowed: [JobState, JobState][] = [
      ["queued", "running"],
      ["queued", "budget_blocked"],
      ["queued", "skipped"],
      ["queued", "cancelled"],
      ["running", "succeeded"],
      ["running", "failed"],
      ["running", "waiting_approval"],
      ["running", "cancelling"],
      ["running", "queued"],
      ["waiting_approval", "running"],
      ["waiting_approval", "cancelling"],
      ["cancelling", "cancelled"],
      ["budget_blocked", "queued"],
      ["budget_blocked", "cancelled"],
    ];
    for (const [a, b] of allowed) expect(canTransition(a, b), `${a}→${b}`).toBe(true);
    // Terminal states never move; nothing jumps straight from queued to succeeded or running to cancelled.
    for (const t of ["succeeded", "failed", "cancelled", "skipped"] as const) for (const to of JOB_STATES) expect(canTransition(t, to)).toBe(false);
    expect(canTransition("queued", "succeeded")).toBe(false);
    expect(canTransition("running", "cancelled")).toBe(false);
    expect(canTransition("budget_blocked", "running")).toBe(false);
  });

  it("budget gate counts spend, reservations and the estimate; override bypasses", () => {
    expect(budgetGate({ spentToday: 4.5, reserved: 0.25, estimate: 0.25, daily: 5, override: false })).toEqual({ ok: true });
    expect(budgetGate({ spentToday: 4.5, reserved: 0.26, estimate: 0.25, daily: 5, override: false })).toEqual({ ok: false, reason: "budget" });
    expect(budgetGate({ spentToday: 0.1, reserved: 0, estimate: 0.25, daily: 0.1, override: false }).ok).toBe(false);
    expect(budgetGate({ spentToday: 99, reserved: 9, estimate: 1, daily: 5, override: true }).ok).toBe(true);
    expect(budgetGate({ spentToday: 0.1, reserved: 0.2, estimate: 0, daily: 0.3, override: false }).ok).toBe(true);
    expect(overCap(0.031, 0.03)).toBe(true);
    expect(overCap(0.03, 0.03)).toBe(false);
    expect(overCap(null, 0.03)).toBe(false);
  });

  it("owner-approved defaults: $5/day, caps 0.03/0.75/2.50, calendar writes off, Hermes flags conservative", () => {
    expect(DEFAULT_AI_SETTINGS.dailyBudgetUsd).toBe(5);
    expect(DEFAULT_AI_SETTINGS.jobCapsUsd).toEqual({ triage: 0.03, standard: 0.75, deep: 2.5 });
    expect(DEFAULT_AI_SETTINGS.schedule.calendarWrite.enabled).toBe(false);
    expect(DEFAULT_AI_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_AI_SETTINGS.hermes).toEqual({ perRunModel: false, midRunCost: false, imageInput: false });
    expect(aiSettingsSchema.parse(DEFAULT_AI_SETTINGS)).toEqual(DEFAULT_AI_SETTINGS);
  });

  it("local day boundary follows the household time zone", () => {
    const tz = "America/Chicago";
    expect(localDay(new Date("2026-10-26T04:59:00Z"), tz)).toBe("2026-10-25");
    expect(localDay(new Date("2026-10-26T05:00:00Z"), tz)).toBe("2026-10-26");
    expect(localDayStart(new Date("2026-10-26T12:00:00Z"), tz).toISOString()).toBe("2026-10-26T05:00:00.000Z");
    // DST end (Nov 1 2026 in the US): midnight is CDT (UTC-5).
    expect(localDayStart(new Date("2026-11-01T18:00:00Z"), tz).toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(localDayStart(new Date("2026-11-02T18:00:00Z"), tz).toISOString()).toBe("2026-11-02T06:00:00.000Z");
  });

  it("lanes, tiers, visibility and retry policy", () => {
    expect(laneFor("triage")).toBe("triage");
    expect(laneFor("schedule")).toBe("triage");
    expect(laneFor("research")).toBe("work");
    expect(tierFor("research")).toBe("standard");
    expect(tierFor("research", { deep: true })).toBe("deep");
    expect(tierFor("triage", { deep: true })).toBe("triage");
    expect(visibleFor("research")).toBe(true);
    expect(visibleFor("investigate")).toBe(true);
    expect(visibleFor("schedule")).toBe(false);
    expect(visibleFor("triage")).toBe(false);
    expect(retryable("upstream", 1)).toBe(true);
    expect(retryable("upstream", 2)).toBe(false);
    expect(retryable("hermes_unavailable", 0)).toBe(true);
    for (const c of ["timeout", "bad_output", "approval_required", "cost_cap", "finance_excluded", "cancelled"] as const) expect(retryable(c, 0)).toBe(false);
    expect(backoffMs(0)).toBe(30_000);
    expect(backoffMs(2)).toBe(120_000);
  });

  const FINANCE = [
    "Chase checking balance $4,210",
    "Monarch says net worth dipped",
    "move 401k rollover",
    "card 4111 1111 1111 1111 exp 12/29",
    "IBAN DE89370400440532013000",
    "routing number 021000021",
    "account number: 123456789012",
    "Amex statement $1,203.44 due friday",
    "mortgage payment $2,350 this month",
    "pay taxes 1099 $830.00",
    "savings balance 12,400.00 at Ally",
    "venmo dad $45 for dinner",
    "Fidelity brokerage $10,000 transfer",
    "credit card APR 24.9% on $3,000",
    "W-2 arrived, salary $120000 dollars",
    "Roth IRA contribution $7,000",
  ];
  const CREDENTIALS = [
    "api_key=sk-abcdefghijklmnopqrstuvwx",
    "my github token ghp_abcdefghijklmnopqrstuvwxyz0123",
    "password: hunter2hunter2",
    "Authorization: Bearer abcdefghijklmnop",
    "-----BEGIN RSA PRIVATE KEY-----",
    "AKIAABCDEFGHIJKLMNOP",
  ];
  const SAFE = [
    "Research best backyard composting setup",
    "Fix the garage door sensor",
    "Buy a birthday gift for mom",
    "Plan v5 rollout for Momentum Bets",
    "call plumber about the leak",
    "https://github.com/NickBolles/Personal-dashboard/pull/14",
    "Meeting on 2026-10-25 at 10:30",
    "Read 'The Phoenix Project'",
    "Pick up 2 bags of mulch",
    "Ticket #4111 in the backlog",
    "screenshot of an error in the build",
    "budget meeting notes for the club",
  ];

  it("finance heuristic: ≥30 fixtures (positives, credentials and negatives)", () => {
    expect(FINANCE.length + CREDENTIALS.length + SAFE.length).toBeGreaterThanOrEqual(30);
    for (const t of FINANCE) expect(detectSensitivity(t), t).toBe("finance");
    for (const t of CREDENTIALS) expect(detectSensitivity(t), t).toBe("credentials");
    for (const t of SAFE) expect(detectSensitivity(t), t).toBe("none");
  });

  it("finance guard: Finance area always excluded (immutable), credentials have no override", () => {
    const fin = { title: "Finance", systemKey: null, aiPolicy: "allowed" as const };
    expect(effectiveAreaPolicy(fin)).toBe("excluded");
    expect(effectiveAreaPolicy({ title: "Finances 2026", aiPolicy: "allowed" })).toBe("excluded");
    expect(effectiveAreaPolicy({ title: "Home", systemKey: "finance" })).toBe("excluded");
    expect(effectiveAreaPolicy({ title: "Home", aiPolicy: "triage_only" })).toBe("triage_only");
    expect(effectiveAreaPolicy(null)).toBe("allowed");
    expect(financeGuard({ kind: "research", area: fin, text: "Compare HYSA" })).toMatchObject({ ok: false, reason: "area_excluded" });
    expect(financeGuard({ kind: "research", area: fin, text: "x", financeOverride: true })).toMatchObject({ ok: false, reason: "area_excluded" });
    expect(financeGuard({ kind: "triage", area: null, text: "Chase checking balance $4,210" })).toMatchObject({ ok: false, reason: "finance_detected" });
    expect(financeGuard({ kind: "triage", area: null, text: "Chase checking balance $4,210", financeOverride: true })).toEqual({ ok: true });
    expect(financeGuard({ kind: "triage", area: null, text: "password: hunter2hunter2", financeOverride: true })).toMatchObject({
      ok: false,
      reason: "credentials_detected",
    });
    expect(financeGuard({ kind: "research", area: { title: "Home", aiPolicy: "triage_only" }, text: "x" })).toMatchObject({
      ok: false,
      reason: "area_triage_only",
    });
    expect(financeGuard({ kind: "triage", area: { title: "Home", aiPolicy: "triage_only" }, text: "x" })).toEqual({ ok: true });
    // Area settings default to allowed and round-trip the policy.
    expect(parseAreaSettings(null).aiPolicy).toBe("allowed");
    expect(parseAreaSettings(JSON.stringify({ aiPolicy: "excluded" })).aiPolicy).toBe("excluded");
  });

  it("investigate threshold, modes and area policy", () => {
    const s = DEFAULT_AI_SETTINGS;
    const t = { shouldInvestigate: true, confidence: 0.6, sensitivity: "none" as const };
    expect(shouldInvestigate(t, s)).toBe(true);
    expect(shouldInvestigate({ ...t, confidence: 0.59 }, s)).toBe(false);
    expect(shouldInvestigate({ ...t, shouldInvestigate: false }, s)).toBe(false);
    expect(shouldInvestigate({ ...t, sensitivity: "finance" }, s)).toBe(false);
    expect(shouldInvestigate(t, s, "triage_only")).toBe(false);
    expect(shouldInvestigate(t, s, "auto", "triage_only")).toBe(false);
    expect(shouldInvestigate(t, { capture: { ...s.capture, auto: "triage_only" } })).toBe(false);
    expect(captureFollowUp("triage_and_investigate", "inherit", "auto")).toBe("triage_and_investigate");
    expect(captureFollowUp("triage_and_investigate", "triage_only", "auto")).toBe("triage_only");
    expect(captureFollowUp("triage_and_investigate", "inherit", "off")).toBe("off");
    expect(captureFollowUp("triage_only", "inherit", "auto")).toBe("triage_only");
    expect(captureFollowUp("off", undefined, undefined)).toBe("off");
  });
});

describe("suggest a time (pure)", () => {
  const tz = "America/Chicago";
  const base = {
    durationMinutes: 60,
    busy: [],
    workHours: { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] },
    quietHours: { enabled: true, start: "22:00", end: "07:00" },
    tz,
    // Monday 2026-10-26 08:00 CDT
    now: new Date("2026-10-26T13:00:00Z"),
  };

  it("returns 3 future slots, one per day, deterministic", () => {
    const a = findSlots(base);
    expect(a).toHaveLength(3);
    expect(findSlots(base)).toEqual(a);
    for (const s of a) expect(Date.parse(s.start)).toBeGreaterThan(base.now.getTime());
    expect(new Set(a.map((s) => s.start.slice(0, 10))).size).toBe(3);
  });

  it("avoids busy blocks with a 15-minute buffer and honours quiet hours, earliest and deadline", () => {
    // Busy the whole first three days from 07:00 to 21:00 local.
    const busy = ["2026-10-26", "2026-10-27", "2026-10-28"].map((d) => ({
      start: zonedToUtc(d, 7 * 60, tz).toISOString(),
      end: zonedToUtc(d, 21 * 60, tz).toISOString(),
    }));
    const s = findSlots({ ...base, busy });
    for (const x of s) expect(x.start >= zonedToUtc("2026-10-29", 0, tz).toISOString()).toBe(true);
    const tight = findSlots({
      ...base,
      busy: [{ start: zonedToUtc("2026-10-26", 9 * 60, tz).toISOString(), end: zonedToUtc("2026-10-26", 10 * 60, tz).toISOString() }],
      deadline: "2026-10-26",
    });
    for (const x of tight) {
      const st = Date.parse(x.start);
      const en = Date.parse(x.end);
      const bs = Date.parse(zonedToUtc("2026-10-26", 9 * 60, tz).toISOString()) - 15 * 60_000;
      const be = Date.parse(zonedToUtc("2026-10-26", 10 * 60, tz).toISOString()) + 15 * 60_000;
      expect(st >= be || en <= bs).toBe(true);
      expect(x.start.slice(0, 10)).toBe("2026-10-26");
    }
    const later = findSlots({ ...base, earliest: "2026-11-02" });
    for (const x of later) expect(x.start >= "2026-11-02").toBe(true);
    // Quiet hours 22–07: nothing starts before 07:00 or ends after 21:00 local.
    for (const x of findSlots({ ...base, durationMinutes: 30 })) {
      const local = new Date(x.start).toLocaleTimeString("en-US", { timeZone: tz, hourCycle: "h23" });
      expect(local >= "07:00").toBe(true);
    }
  });

  it("prefers requested windows, penalises all-day events, splits when allowed", () => {
    const evening = findSlots({ ...base, preferredWindows: ["evening"] });
    for (const x of evening)
      expect(Number(new Date(x.start).toLocaleTimeString("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit" }))).toBeGreaterThanOrEqual(17);
    const allDay = findSlots({ ...base, busy: [{ start: "2026-10-26", allDay: true }] });
    expect(allDay[0]!.start.slice(0, 10)).not.toBe("2026-10-26");
    // 14 h task can't fit in a day; splitOk finds two 7 h halves.
    expect(findSlots({ ...base, durationMinutes: 15 * 60 })).toHaveLength(0);
    expect(findSlots({ ...base, durationMinutes: 15 * 60, splitOk: true })[0]?.why).toMatch(/first of two/);
  });

  it("handles the DST week (Nov 1) with correct UTC offsets", () => {
    const now = new Date("2026-10-30T13:00:00Z");
    const s = findSlots({ ...base, now, preferredWindows: ["morning"], earliest: "2026-11-02", deadline: "2026-11-02" });
    expect(s[0]!.start).toBe("2026-11-02T14:00:00.000Z"); // 08:00 CST (work hours start) = 14:00 UTC
    expect(zonedToUtc("2026-10-30", 7 * 60, tz).toISOString()).toBe("2026-10-30T12:00:00.000Z"); // CDT
  });
});

describe("output schemas", () => {
  it("validate per kind and reject bad shapes", () => {
    expect(OUTPUT_SCHEMAS.plan.safeParse({ title: "P", steps: [] }).success).toBe(false);
    expect(OUTPUT_SCHEMAS.plan.safeParse({ title: "P", steps: [{ title: "a" }] }).success).toBe(true);
    expect(OUTPUT_SCHEMAS.schedule.safeParse({ durationMinutes: 2 }).success).toBe(false);
    expect(OUTPUT_SCHEMAS.triage.parse({ title: "T", kind: "weird", sensitivity: "?" })).toMatchObject({ kind: "other", sensitivity: "none" });
    expect(OUTPUT_SCHEMAS.research.safeParse({ summary: "no title" }).success).toBe(false);
  });
});

describe("finance never reaches the AI layer (static import graph)", () => {
  const root = path.resolve(__dirname, "..");
  const resolve = (from: string, spec: string) => {
    let base: string;
    if (spec.startsWith("@/")) base = path.join(root, spec.slice(2));
    else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
    else return null;
    for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    return null;
  };
  const FORBIDDEN = /[\\/](server|lib|integrations)[\\/](finance|monarch)[\\/]|[\\/]integrations[\\/]index\.ts$/;

  it("no module reachable from server/ai/** or integrations/hermes/jobs.ts is a finance module", () => {
    const entries = [
      ...fs
        .readdirSync(path.join(root, "server/ai"))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => path.join(root, "server/ai", f)),
      path.join(root, "integrations/hermes/jobs.ts"),
    ];
    const seen = new Set<string>();
    const stack = [...entries];
    const offenders: string[] = [];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      if (FORBIDDEN.test(f)) offenders.push(path.relative(root, f));
      const src = fs.readFileSync(f, "utf8");
      // Static imports and re-exports (type-only imports are erased and can't leak data, but are followed anyway).
      for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g)) {
        const r = resolve(f, m[1] ?? m[2]!);
        if (r) stack.push(r);
      }
      // Dynamic imports: only the allowlisted lazy boundaries (server/context.ts drops finance itself).
      for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
        if (!["@/server/context", "@/integrations/home-assistant/client", "./jobs", "./settings"].includes(m[1]!))
          offenders.push(`${path.relative(root, f)} → import(${m[1]})`);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
