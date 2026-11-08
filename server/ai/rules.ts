/**
 * Pure rules for AI jobs (phase 5): state machine, budget gate, lanes/tiers,
 * the area/sensitivity guard, investigate decision, retry policy. No I/O,
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
  return kind !== "triage" && kind !== "schedule" && kind !== "file" && kind !== "summarize";
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

// --- Area policy & sensitivity guard (spec §5) ---

export type AreaRef = { title: string; systemKey?: string | null; aiPolicy?: AiPolicy | null } | null | undefined;

/** Every area, including Finance, honours the owner's generic AI policy. */
export function effectiveAreaPolicy(area: AreaRef): AiPolicy {
  return area?.aiPolicy ?? "allowed";
}

const CARD = /\b(?:\d[ -]?){13,19}\b/;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;
const ROUTING = /\b(routing|aba|account|acct)\s*(no\.?|number|#)?\s*[:#]?\s*\d{6,17}\b/i;
const AMOUNT = /(\$\s?\d[\d,]*(\.\d{1,2})?|\b\d[\d,]*\.\d{2}\b|\b\d+(\.\d+)?\s?(usd|dollars)\b)/i;
const FIN_WORDS =
  /\b(balance|balances|statement|checking|savings|monarch|401k|401\(k\)|ira|roth|mortgage|tax|taxes|irs|w-?2|1099|paycheck|salary|brokerage|credit card|debit|chase|amex|american express|wells fargo|bank of america|citi|capital one|fidelity|vanguard|schwab|venmo|zelle|paypal|loan|apr|net worth|budget)\b/i;
const FIN_STRONG = /\b(monarch|401k|401\(k\)|roth ira|net worth|routing number|account number|bank statement|tax return)\b/i;

// --- Credentials (never sent to AI) ---
//
// A keyword alone is NOT a credential: "token expired", "Rotate the agent token before Friday",
// "Authorization header missing" are ordinary prose. The old rule (keyword + whitespace + any 6-char
// word) blocked such chat messages outright ("Credentials are never sent to AI", 2026-11-07). Now a
// keyword counts only when it is ASSIGNED a value (`password: hunter2`, `token=…`, `"api_key": "…"`)
// or followed by a token-shaped value (letters AND digits, 16+ chars). Known key formats, JWTs, Bearer
// headers, URL user:pass and PEM private keys are caught anywhere. Jarvis/Hermes ids and URLs are not secrets.

const SECRET_WORD = String.raw`(?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?(?:access[_-]?)?key|client[_-]?secret|(?:auth|access|refresh|bearer|session|bot|api)[_-]?token|token|secret|password|passwd|pwd|passcode|passphrase|authorization)`;
/**
 * `password: x`, `token=x`, `"api_key": "x"`, `Authorization: Bearer x` (value checked by `assignedValue`).
 * A quoted value runs to its closing quote, so `password="hunter2,second half"` is masked whole.
 */
const Q = "\"'`";
const ASSIGNED = new RegExp(
  // Quoted values honour backslash escapes (`"pa\"ss"` in pasted JSON is one value, not `pa\`), have
  // no length cap, run across lines to the closing delimiter (template literals, """…"""), and a
  // quote that never closes fails closed: the rest of the text is the value.
  String.raw`(?<![A-Za-z0-9])(${SECRET_WORD})["']?\s*[:=]\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|\x60((?:\\[\s\S]|[^\x60\\])*)\x60|[${Q}]([\s\S]+)|(?:(?:bearer|basic|token)\s+)?([^\s${Q}]+))`,
  "gid",
);
/** `token abc123…` / `password is X9f…`: only token-shaped values (checked by `tokenShaped`). */
const SPACED = new RegExp(String.raw`(?<![A-Za-z0-9])(${SECRET_WORD})\s+(?:is\s+|was\s+|of\s+)?["']?([A-Za-z0-9._~+/=-]{16,})`, "gi");
const BEARER = /\b(?:bearer|basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi;
const AUTH_HEADER = /(?<![A-Za-z0-9])(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+([A-Za-z0-9._~+/=-]{4,})/gi;
const KEYLIKE = new RegExp(
  [
    String.raw`sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}`,
    String.raw`(?:rk|pk)_live_[A-Za-z0-9]{16,}`,
    String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`github_pat_[A-Za-z0-9_]{20,}`,
    String.raw`glpat-[A-Za-z0-9_-]{20,}`,
    String.raw`xox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}`,
    String.raw`AIza[0-9A-Za-z_-]{35}`,
    String.raw`(?:jdv|jcap|jva)_[A-Za-z0-9_-]{16,}`,
    String.raw`eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
  ]
    .map((p) => `(?<![A-Za-z0-9_-])${p}`)
    .join("|"),
  "g",
);
const URL_CREDS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)/g;

/**
 * Ids and placeholders that look like values but are never secrets. Only checked for values that
 * follow a credential keyword or Bearer, so a bare UUID is NOT exempt here: `token=<uuid>` is a
 * credential (UUIDs elsewhere in prose never match a credential pattern in the first place).
 */
const NOT_SECRET = [
  /^api_\d{6,}_[0-9a-f]{4,}$/i, // Hermes/Jarvis session ids (jarvis.nickbolles.com/chat/api_…)
  /^(?:wk|item|node)[_:-]/i, // Jarvis work item ids
  // Only Jarvis/artifacts pages and plain GitHub pages (no query): any other URL after a credential
  // keyword (`secret=https://discord.com/api/webhooks/…`, `?token=` links) can BE the credential.
  /^https?:\/\/(?:(?:jarvis|artifacts)\.nickbolles\.com|github\.com)(?:\/[^\s?#]*)?$/i,
  /^\$\{?[A-Z_][A-Z0-9_]*\}?$/, // ${VAR} / $VAR placeholders
  /^(?:process\.env|os\.environ|env)[.[]/, // code reading a secret, not the secret
  /^<[^>]*>?$/,
  /^\[secret removed\]$/, // already masked
  /^(?:\*{3,}|x{4,}|\.{3,}|…|•+\d*|redacted|null|none|undefined|true|false|required|optional|set|unset|missing|expired|invalid|revoked|here)$/i,
];
const notSecret = (v: string) => NOT_SECRET.some((r) => r.test(v));
/** Assigned values: 6+ chars with a digit/symbol, or a 16+ letter passphrase. Plain words ("expired") aren't secrets. */
const assignedValue = (v: string) => !notSecret(v) && v.length >= 6 && (/[\d_\-+/=.~!@#$%^&*]/.test(v) ? /[A-Za-z0-9]/.test(v) : v.length >= 16);
/** Unassigned values must look like a generated token: letters AND digits, 16+ chars. */
const tokenShaped = (v: string) => !notSecret(v) && v.length >= 16 && /[A-Za-z]/.test(v) && /\d/.test(v);

export type SecretFinding = { kind: string; start: number; end: number; hint: string };

const KEY_KINDS: [RegExp, string][] = [
  [/^sk-ant-/, "Anthropic key"],
  [/^sk-/, "API key"],
  [/^(?:rk|pk)_live_/, "Stripe key"],
  [/^gh[pousr]_|^github_pat_/, "GitHub token"],
  [/^glpat-/, "GitLab token"],
  [/^xox/, "Slack token"],
  [/^(?:AKIA|ASIA)/, "AWS key"],
  [/^AIza/, "Google API key"],
  [/^(?:jdv|jcap|jva)_/, "Jarvis token"],
  [/^eyJ/, "JWT"],
];

/**
 * Every credential-looking span in `text`. `start`/`end` cover only the secret VALUE (the keyword
 * stays readable after masking); `hint` names the part for the owner without echoing the secret
 * (keyword or key prefix + "…").
 */
export function findSecrets(text: string): SecretFinding[] {
  if (!text) return [];
  const all: SecretFinding[] = [];
  const add = (kind: string, start: number, end: number, hint: string) => all.push({ kind, start, end, hint });
  for (const m of text.matchAll(PEM)) add("Private key", m.index!, m.index! + m[0].length, "-----BEGIN … PRIVATE KEY-----");
  for (const m of text.matchAll(KEYLIKE)) {
    const v = m[0];
    const kind = KEY_KINDS.find(([r]) => r.test(v))?.[1] ?? "API key";
    add(kind, m.index!, m.index! + v.length, `${v.slice(0, v.startsWith("eyJ") ? 3 : Math.min(v.indexOf("_") + 1 || 4, 8))}…`);
  }
  for (const m of text.matchAll(URL_CREDS)) {
    const start = m.index! + m[0].length - 1 - m[1]!.length;
    add("Password in a URL", start, start + m[1]!.length, `${m[0].slice(0, m[0].indexOf("://") + 3)}user:…@`);
  }
  for (const m of text.matchAll(ASSIGNED)) {
    const g = [2, 3, 4, 5, 6, 7, 8].find((i) => m[i] !== undefined);
    if (!g || !m.indices?.[g]) continue;
    // Unquoted: trailing sentence punctuation isn't part of the value; commas INSIDE it are (masked whole).
    const v = g === 8 ? m[g]!.replace(/[.,;:)}\]]+$/, "") : m[g]!;
    if (!assignedValue(v)) continue;
    const start = m.indices[g]![0];
    const sep = m[0].slice(m[1]!.length).match(/[:=]/)?.[0] ?? ":";
    add("Credential", start, start + v.length, `${m[1]}${sep} …`);
  }
  for (const m of text.matchAll(AUTH_HEADER)) {
    // An explicit `Authorization: Basic|Bearer <value>` header is a credential whatever its shape
    // (`Basic dXNlcjpwYXNz` = user:pass is letters only and short).
    const v = m[1]!;
    if (notSecret(v)) continue;
    const start = m.index! + m[0].length - v.length;
    add("Bearer token", start, start + v.length, `${m[0].slice(0, m[0].length - v.length).trim()} …`);
  }
  for (const m of text.matchAll(BEARER)) {
    const v = m[1]!;
    // "Basic auth-based login" / "bearer authentication" are prose; tokens have digits, base64 padding or length.
    if (!(v.length >= 20 || (/\d/.test(v) && /[A-Za-z]/.test(v)) || /[+/=]/.test(v)) || notSecret(v)) continue;
    const start = m.index! + m[0].length - v.length;
    add("Bearer token", start, start + v.length, `${m[0].slice(0, m[0].length - v.length).trim()} …`);
  }
  for (const m of text.matchAll(SPACED)) {
    const v = m[2]!;
    if (!tokenShaped(v)) continue;
    const start = m.index! + m[0].length - v.length;
    // `password "abc123… second half"`: a quoted value runs to its closing quote (or the end, fail closed).
    const q = text[start - 1];
    let end = start + v.length;
    if (q === '"' || q === "'") {
      const close = text.indexOf(q, end);
      end = close === -1 ? text.length : close;
    }
    add("Credential", start, end, `${m[1]} …`);
  }
  // Overlapping spans are UNIONED (never dropped): a key-shaped substring inside a quoted password
  // must not leave the rest of the password unmasked. The widest finding names the merged span.
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: (SecretFinding & { width: number })[] = [];
  for (const f of all) {
    const prev = out[out.length - 1];
    if (prev && f.start < prev.end) {
      if (f.end - f.start > prev.width) Object.assign(prev, { kind: f.kind, hint: f.hint, width: f.end - f.start });
      prev.end = Math.max(prev.end, f.end);
    } else out.push({ ...f, width: f.end - f.start });
  }
  return out.map(({ kind, start, end, hint }) => ({ kind, start, end, hint }));
}

export const SECRET_MASK = "[secret removed]";

export type MaskedSecrets = {
  text: string;
  /** What was removed, for the owner ("password: …", "ghp_…"); never the secret itself. */
  masked: { kind: string; hint: string }[];
  /** Nothing meaningful is left once the secrets are removed: the message IS a credential. */
  onlySecrets: boolean;
};

/** Replace each credential value with `[secret removed]`; the rest of the text goes through unchanged. */
export function maskSecrets(text: string): MaskedSecrets {
  const found = findSecrets(text);
  if (!found.length) return { text, masked: [], onlySecrets: false };
  let out = "";
  let last = 0;
  for (const f of found) {
    out += text.slice(last, f.start) + SECRET_MASK;
    last = f.end;
  }
  out += text.slice(last);
  let rest = "";
  last = 0;
  for (const f of found) {
    rest += ` ${text.slice(last, f.start)}`;
    last = f.end;
  }
  rest += text.slice(last);
  // What's left besides the keywords themselves ("password:", "Authorization: Bearer"), in any script
  // (a Chinese request plus a token is a request, not a bare credential).
  const letters = rest
    .replace(new RegExp(String.raw`\b${SECRET_WORD}\b|\b(?:bearer|basic|is|my|the|here|it|this|use)\b`, "gi"), " ")
    .match(new RegExp("\\p{L}", "gu"));
  return { text: out, masked: found.map(({ kind, hint }) => ({ kind, hint })), onlySecrets: (letters?.length ?? 0) < 6 };
}

/** The owner-facing refusal: names the flagged part (never the secret) so the owner can edit it out; the draft stays. */
export function credentialsMessage(masked: { hint: string }[], what = "message") {
  const parts = [...new Set(masked.map((m) => m.hint))].slice(0, 3).join(", ");
  return `Credentials are never sent to AI: this ${what} is only a secret${parts ? ` (${parts})` : ""}. Edit it to describe what you need and send again.`;
}

export type Sensitivity = "none" | "personal" | "finance" | "credentials";

/** Conservative text heuristic: false positives only cost a manual filing. */
export function detectSensitivity(text: string): Sensitivity {
  if (!text) return "none";
  if (findSecrets(text).length) return "credentials";
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
  /** Accepted but ignored for compatibility with older clients. */
  financeOverride?: boolean;
};
export type GuardResult = { ok: true } | { ok: false; code: "finance_excluded"; reason: "area_excluded" | "area_triage_only" | "credentials_detected" };

/** Run at enqueue AND at execution (an item can move between the two). */
export function aiGuard(g: GuardInput): GuardResult {
  const policy = effectiveAreaPolicy(g.area);
  if (policy === "excluded") return { ok: false, code: "finance_excluded", reason: "area_excluded" };
  if (policy === "triage_only" && g.kind !== "triage") return { ok: false, code: "finance_excluded", reason: "area_triage_only" };
  const sens = detectSensitivity(g.text);
  if (sens === "credentials") return { ok: false, code: "finance_excluded", reason: "credentials_detected" };
  return { ok: true };
}

/** Compatibility alias for existing callers. */
export const financeGuard = aiGuard;

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
  if (t.sensitivity === "credentials") return false;
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
    finance_excluded: "Not sent to AI (area excluded from AI or credentials detected)",
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
