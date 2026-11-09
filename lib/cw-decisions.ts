/**
 * CW-2/CW-3 owner decisions (D-n): client-safe types, input schemas and the pure
 * state machine. Persistence lives in server/work/decision-store.ts.
 *
 * Rules (owner-approved 2026-11-08, coordinator workflow v3):
 * - every decision has a stable per-owner id "D-n" that is never reused;
 * - several decisions can be open on one item;
 * - only the owner session answers or defers; agents raise and may supersede/withdraw
 *   decisions THEY raised, never answer;
 * - a default answer applies on expiry only for low-risk decisions (no risk flag);
 *   permission / credential / device / money / destructive / public decisions never default.
 */
import { z } from "zod";

export const DECISION_STATES = ["open", "answered", "defaulted", "superseded", "deferred", "withdrawn"] as const;
export type DecisionState = (typeof DECISION_STATES)[number];
/** States that still wait on the owner (deferred comes back on its own). */
export const PENDING_STATES: readonly DecisionState[] = ["open", "deferred"];

export const RISK_FLAGS = ["permission", "credential", "device", "money", "destructive", "public"] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];
export const RISK_LABEL: Record<RiskFlag, string> = {
  permission: "Permission",
  credential: "Credential",
  device: "Device",
  money: "Money",
  destructive: "Destructive",
  public: "Public exposure",
};

export const ANSWER_VIA = ["queue", "item", "default", "push", "chat"] as const;
export type AnswerVia = (typeof ANSWER_VIA)[number];

export const DECISION_REF = /^D-([1-9]\d{0,8})$/;
export const decisionRef = (seq: number) => `D-${seq}`;
export function parseDecisionRef(ref: string): number | null {
  const m = DECISION_REF.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

const str = (max: number) => z.string().trim().max(max);

export const evidenceSchema = z
  .object({
    kind: z.enum(["pr", "issue", "board", "diff", "log", "run", "item", "url", "image", "code"]),
    label: str(200).min(1),
    /** https URL or same-origin path; validated again on read */
    url: str(2000).optional(),
    /** diff/code/log excerpt shown as text (never executed or fetched) */
    text: str(4000).optional(),
    ref: str(64).optional(),
  })
  .strict();
export type DecisionEvidence = z.infer<typeof evidenceSchema>;

export const packSchema = z
  .object({
    why: str(600).optional(),
    facts: z
      .array(z.object({ label: str(60).min(1), value: str(400).min(1) }).strict())
      .max(12)
      .optional(),
    /** consequence of each choice, keyed by the choice text */
    options: z
      .array(z.object({ choice: str(120).min(1), effect: str(400).min(1) }).strict())
      .max(6)
      .optional(),
    evidence: z.array(evidenceSchema).max(12).optional(),
    /** what answering unblocks: item ids, run refs (R-n), PRs ("#252") */
    unblocks: z.array(str(120).min(1)).max(12).optional(),
  })
  .strict();
export type DecisionPack = z.infer<typeof packSchema>;

/** One decision raise (MCP jarvis_raise_decision and server callers). Cross-field rules: validateRaise. */
export const raiseSchema = z
  .object({
    question: str(500).min(1),
    choices: z.array(str(120).min(1)).max(6).optional(),
    recommended: str(120).min(1).optional(),
    risk: z.array(z.enum(RISK_FLAGS)).max(RISK_FLAGS.length).optional(),
    pack: packSchema.optional(),
    detail: str(4000).optional(),
    defaultChoice: str(120).min(1).optional(),
    /** ISO timestamp; required with defaultChoice, at least 10 min and at most 30 days ahead */
    expiresAt: z.string().datetime({ offset: true }).optional(),
    runId: str(64).min(1).optional(),
  })
  .strict();
export type RaiseInput = z.infer<typeof raiseSchema>;

export const DEFAULT_MIN_MS = 10 * 60_000;
export const DEFAULT_MAX_MS = 30 * 86_400_000;

export type RaiseCheck = { ok: true } | { ok: false; code: string; message: string };

/** Cross-field rules for a raise. Pure; the store calls it before every insert. */
export function validateRaise(input: RaiseInput, now = new Date()): RaiseCheck {
  const choices = dedupe(input.choices ?? []);
  if (input.recommended && !choices.includes(input.recommended.trim()))
    return { ok: false, code: "recommended", message: "recommended must be one of the choices" };
  for (const o of input.pack?.options ?? [])
    if (!choices.includes(o.choice.trim())) return { ok: false, code: "pack_option", message: `pack option "${o.choice}" isn't one of the choices` };
  const hasDefault = input.defaultChoice !== undefined || input.expiresAt !== undefined;
  if (hasDefault) {
    if ((input.risk ?? []).length)
      return { ok: false, code: "default_risk", message: "Risk-flagged decisions (permission, credential, device, money, …) never get a default" };
    if (!input.defaultChoice || !input.expiresAt)
      return { ok: false, code: "default_pair", message: "defaultChoice and expiresAt go together" };
    if (!choices.includes(input.defaultChoice.trim())) return { ok: false, code: "default_choice", message: "defaultChoice must be one of the choices" };
    const ms = Date.parse(input.expiresAt) - now.getTime();
    if (!(ms >= DEFAULT_MIN_MS && ms <= DEFAULT_MAX_MS))
      return { ok: false, code: "expires_at", message: "expiresAt must be between 10 minutes and 30 days from now" };
  }
  return { ok: true };
}

export const dedupe = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

export type DecisionTransition = "answer" | "default" | "supersede" | "withdraw" | "defer" | "reopen" | "undefer";

/** Which transitions are legal from which state (owner/agent rules are checked by the caller). */
export function nextState(from: DecisionState, t: DecisionTransition): DecisionState | null {
  switch (t) {
    case "answer":
      return from === "open" || from === "deferred" ? "answered" : null;
    case "default":
      return from === "open" ? "defaulted" : null;
    case "supersede":
      return from === "open" || from === "deferred" ? "superseded" : null;
    case "withdraw":
      return from === "open" || from === "deferred" ? "withdrawn" : null;
    case "defer":
      return from === "open" || from === "deferred" ? "deferred" : null;
    case "undefer":
      return from === "deferred" ? "open" : null;
    case "reopen":
      // Undo of an answer / default / withdraw (the op's own undo window applies).
      return from === "answered" || from === "defaulted" || from === "withdrawn" ? "open" : null;
  }
}

/** A default may apply only to an open, low-risk decision whose expiry has passed. */
export function shouldDefault(d: { state: DecisionState; risk: RiskFlag[]; defaultChoice: string | null; expiresAt: string | null }, now = new Date()) {
  return d.state === "open" && d.risk.length === 0 && !!d.defaultChoice && !!d.expiresAt && Date.parse(d.expiresAt) <= now.getTime();
}

/** Wire shape of one decision (GET /api/coordinator/decisions, MCP list). */
export type Decision = {
  id: string;
  ref: string;
  seq: number;
  itemId: string;
  itemTitle?: string;
  areaTitle?: string;
  runId: string | null;
  runRef?: string | null;
  question: string;
  choices: string[];
  recommended: string | null;
  risk: RiskFlag[];
  pack: DecisionPack;
  detail?: string;
  action?: { label: string; href: string };
  defaultChoice: string | null;
  expiresAt: string | null;
  state: DecisionState;
  answeredChoice: string | null;
  answeredAt: string | null;
  answeredVia: AnswerVia | null;
  deferredUntil: string | null;
  supersededBy: string | null;
  raisedBy: string;
  createdAt: string;
  updatedAt: string;
};

export const AGEING_MS = 24 * 3_600_000;

/**
 * Urgency order for the queue and the tray line: ageing (>24 h) first, then risk-flagged,
 * then the soonest default expiry, then newest. Pure (CW-2 ordering).
 */
export function urgencyRank(d: Pick<Decision, "createdAt" | "risk" | "expiresAt">, now = new Date()): number[] {
  const age = now.getTime() - Date.parse(d.createdAt);
  const ageing = age > AGEING_MS ? 0 : 1;
  const risky = d.risk.length ? 0 : 1;
  const exp = d.expiresAt ? Date.parse(d.expiresAt) : Number.MAX_SAFE_INTEGER;
  return [ageing, ageing === 0 ? -age : risky, exp, -Date.parse(d.createdAt)];
}
export function sortByUrgency<T extends Pick<Decision, "createdAt" | "risk" | "expiresAt" | "seq">>(ds: T[], now = new Date()): T[] {
  return [...ds].sort((a, b) => {
    const ra = urgencyRank(a, now);
    const rb = urgencyRank(b, now);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return b.seq - a.seq;
  });
}

export const answerSchema = z
  .object({
    answer: str(2000).min(1),
    via: z.enum(["queue", "push", "chat"]).optional(),
    /** push action replays carry one; a repeat with the same key is a no-op */
    idempotencyKey: str(80).optional(),
  })
  .strict();
export const deferSchema = z
  .object({
    /** ISO time to bring it back; max 30 days */
    until: z.string().datetime({ offset: true }),
  })
  .strict();

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return (JSON.parse(raw) as T) ?? fallback;
  } catch {
    return fallback;
  }
}
export const parseRisk = (raw: string | null | undefined): RiskFlag[] =>
  parseJson<unknown[]>(raw, []).filter((r): r is RiskFlag => (RISK_FLAGS as readonly string[]).includes(String(r)));
export const parseChoices = (raw: string | null | undefined): string[] => parseJson<unknown[]>(raw, []).filter((c): c is string => typeof c === "string");
export function parsePack(raw: string | null | undefined): DecisionPack {
  const r = packSchema.safeParse(parseJson<unknown>(raw, {}));
  return r.success ? r.data : {};
}
