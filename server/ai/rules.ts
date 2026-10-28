/**
 * Pure rules for AI jobs (phase 5): state machine, budget gate, lanes/tiers,
 * the finance/sensitivity guard, investigate decision, retry policy. No I/O,
 * no imports beyond shared types, so it's exhaustively unit-tested
 * (server/ai/rules.test.ts).
 */
import type { AiJobKind, AiLane, AiSettings, AiTier, JobErrorCode, JobState } from "@/lib/ai";
import type { AiPolicy } from "@/lib/work";

const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["running", "budget_blocked", "skipped", "cancelled", "failed"],
  running: ["succeeded", "failed", "waiting_approval", "cancelling", "queued", "skipped"],
  waiting_approval: ["running", "cancelling", "failed", "succeeded"],
  cancelling: ["cancelled", "failed", "succeeded"],
  budget_blocked: ["queued", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: [],
};

export function canTransition(from: JobState, to: JobState) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function laneFor(kind: AiJobKind): AiLane {
  return kind === "triage" || kind === "schedule" || kind === "file" ? "triage" : "work";
}

export function tierFor(kind: AiJobKind, params: { deep?: boolean } = {}): AiTier {
  if (kind === "triage" || kind === "schedule" || kind === "file") return "triage";
  return params.deep ? "deep" : "standard";
}

/** Research/plan/draft/investigate get a visible conversation filed under the item; triage/schedule are hidden and deleted. */
export function visibleFor(kind: AiJobKind) {
  return kind !== "triage" && kind !== "schedule" && kind !== "file";
}

export type BudgetInput = { spentToday: number; reserved: number; estimate: number; daily: number; override: boolean };
export function budgetGate(b: BudgetInput): { ok: true } | { ok: false; reason: "budget" } {
  if (b.override) return { ok: true };
  // Small epsilon so floating sums like 0.1 + 0.2 don't block a job that exactly fits.
  return b.spentToday + b.reserved + b.estimate > b.daily + 1e-9 ? { ok: false, reason: "budget" } : { ok: true };
}

/** Per-job cap check (live when Hermes updates cost mid-run, otherwise post hoc). */
export function overCap(cost: number | null | undefined, cap: number) {
  return cost != null && cost > cap + 1e-9;
}

/** Local calendar day (YYYY-MM-DD) in `tz`, used for the spend ledger and "one budget notice per day". */
export function localDay(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** UTC instant where the local day containing `now` began (DST-safe within an hour; good enough for a ledger). */
export function localDayStart(now: Date, tz: string) {
  const day = localDay(now, tz);
  // Walk back from the UTC midnight guess to the first instant whose local day is `day`.
  let t = Date.parse(`${day}T00:00:00Z`) - 15 * 3600_000;
  while (localDay(new Date(t), tz) !== day) t += 15 * 60_000;
  return new Date(t);
}

const RETRYABLE: readonly JobErrorCode[] = ["upstream", "hermes_unavailable"];
export function retryable(code: JobErrorCode | null | undefined, attempt: number, maxAttempts = 2) {
  return !!code && RETRYABLE.includes(code) && attempt < maxAttempts;
}
export function backoffMs(attempt: number) {
  return 30_000 * 2 ** Math.max(0, attempt);
}

// --- Finance & sensitivity guard (spec §5) ---

export type AreaRef = { title: string; systemKey?: string | null; aiPolicy?: AiPolicy | null } | null | undefined;

/** Finance is always excluded, whatever the stored setting says (immutable here, not just in the UI). */
export function effectiveAreaPolicy(area: AreaRef): AiPolicy {
  if (!area) return "allowed";
  if (isFinanceArea(area)) return "excluded";
  return area.aiPolicy ?? "allowed";
}

export function isFinanceArea(area: { title: string; systemKey?: string | null }) {
  const key = (area.systemKey ?? "").toLowerCase();
  const title = area.title.trim().toLowerCase();
  return key === "finance" || title === "finance" || title === "finances" || /^financ(e|es|ial)\b/.test(title);
}

const CARD = /\b(?:\d[ -]?){13,19}\b/;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
const ROUTING = /\b(routing|aba|account|acct)\s*(no\.?|number|#)?\s*[:#]?\s*\d{6,17}\b/i;
const AMOUNT = /(\$\s?\d[\d,]*(\.\d{1,2})?|\b\d[\d,]*\.\d{2}\b|\b\d+(\.\d+)?\s?(usd|dollars)\b)/i;
const FIN_WORDS =
  /\b(balance|balances|statement|checking|savings|monarch|401k|401\(k\)|ira|roth|mortgage|tax|taxes|irs|w-?2|1099|paycheck|salary|brokerage|credit card|debit|chase|amex|american express|wells fargo|bank of america|citi|capital one|fidelity|vanguard|schwab|venmo|zelle|paypal|loan|apr|net worth|budget)\b/i;
const FIN_STRONG = /\b(monarch|401k|401\(k\)|roth ira|net worth|routing number|account number|bank statement|tax return)\b/i;

const SECRETISH = /(api[_-]?key|token|secret|password|passwd|passcode|authorization)([\s"':=]+)(?:(bearer|basic)\s+)?([^\s"',]{6,})/i;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const KEYLIKE =
  /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|jdv_[A-Za-z0-9_-]{16,}|jcap_[A-Za-z0-9_-]{16,})\b/;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export type Sensitivity = "none" | "personal" | "finance" | "credentials";

/** Conservative text heuristic: false positives only cost a manual filing. */
export function detectSensitivity(text: string): Sensitivity {
  if (!text) return "none";
  if (SECRETISH.test(text) || BEARER.test(text) || KEYLIKE.test(text) || PEM.test(text)) return "credentials";
  if (CARD.test(text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")) && luhnAny(text)) return "finance";
  if (IBAN.test(text) || ROUTING.test(text) || FIN_STRONG.test(text)) return "finance";
  if (AMOUNT.test(text) && FIN_WORDS.test(text)) return "finance";
  return "none";
}

function luhnAny(text: string) {
  for (const m of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 13) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

export type GuardInput = {
  kind: AiJobKind;
  area: AreaRef;
  text: string;
  /** owner pressed "Send anyway" on a heuristic finance match */
  financeOverride?: boolean;
};
export type GuardResult =
  { ok: true } | { ok: false; code: "finance_excluded"; reason: "area_excluded" | "area_triage_only" | "finance_detected" | "credentials_detected" };

/** Run at enqueue AND at execution (an item can move between the two). */
export function financeGuard(g: GuardInput): GuardResult {
  const policy = effectiveAreaPolicy(g.area);
  if (policy === "excluded") return { ok: false, code: "finance_excluded", reason: "area_excluded" };
  if (policy === "triage_only" && g.kind !== "triage") return { ok: false, code: "finance_excluded", reason: "area_triage_only" };
  const sens = detectSensitivity(g.text);
  if (sens === "credentials") return { ok: false, code: "finance_excluded", reason: "credentials_detected" };
  if (sens === "finance" && !g.financeOverride) return { ok: false, code: "finance_excluded", reason: "finance_detected" };
  return { ok: true };
}

export type TriageResult = { shouldInvestigate: boolean; confidence: number; sensitivity: Sensitivity };
export function shouldInvestigate(
  t: TriageResult,
  s: Pick<AiSettings, "capture">,
  mode: "auto" | "triage_only" | "off" | "inherit" = "auto",
  areaPolicy: AiPolicy = "allowed",
) {
  if (mode === "triage_only" || mode === "off") return false;
  if (s.capture.auto !== "triage_and_investigate") return false;
  if (areaPolicy !== "allowed") return false;
  if (t.sensitivity === "finance" || t.sensitivity === "credentials") return false;
  return t.shouldInvestigate && t.confidence >= s.capture.investigateMinConfidence;
}

/** How a capture is followed up given the global mode, the token's mode and the caller's per-capture choice. */
export function captureFollowUp(
  global: AiSettings["capture"]["auto"],
  tokenMode: "inherit" | "triage_only" | "off" | undefined,
  requested: "auto" | "triage_only" | "off" | undefined,
): "triage_and_investigate" | "triage_only" | "off" {
  const rank = { off: 0, triage_only: 1, triage_and_investigate: 2 } as const;
  const pick = (v: string | undefined) => (v === "off" ? "off" : v === "triage_only" ? "triage_only" : null);
  let out: keyof typeof rank = global;
  for (const v of [tokenMode, requested]) {
    const p = pick(v);
    if (p && rank[p] < rank[out]) out = p;
  }
  return out;
}

/** Controlled error text per code (never model output or provider messages). */
export function errorText(code: JobErrorCode, extra?: string) {
  const base: Record<JobErrorCode, string> = {
    timeout: "Hermes didn't finish in time",
    approval_required: "Hermes asked for an approval a background job can't give",
    bad_output: "Hermes couldn't complete it",
    upstream: "Hermes returned an error",
    cost_cap: "Stopped at the per-job cost cap",
    finance_excluded: "Not sent to AI (finance or sensitive content)",
    hermes_unavailable: "Hermes isn't reachable",
    cancelled: "Cancelled",
    ai_disabled: "AI actions are turned off",
    quota: "Paused to keep half of the weekly subscription free",
  };
  const msg = extra ? `${base[code]}: ${extra}` : base[code];
  return msg.slice(0, 300);
}

/** Batch "report ready" pushes: >3 in a 10-minute bucket collapse into one row. */
export function reportBucket(now: Date) {
  return Math.floor(now.getTime() / (10 * 60_000));
}
