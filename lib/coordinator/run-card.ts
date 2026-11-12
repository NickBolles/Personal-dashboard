/**
 * What a run card says: its status in words, a tone and label per event type (the same tones the item
 * pages use for PR / checks / deploy pills), and the "since you last looked" breakdown. Pure and client-safe.
 */
import { isActiveExec, type ExecutionRecord } from "@/lib/chat-execution";
import type { Decision } from "@/lib/cw-decisions";
import type { RunEvent, RunEventType } from "@/lib/cw-runs";
import { relativeTime } from "@/lib/time";
import { ageLabel } from "./needs";
import type { CoordinatorRunRow } from "./runs-view";

export type CardTone = "ok" | "wn" | "bad" | "ai" | "inf" | "ac" | "neutral";

export type RunStatus = {
  key: "failed" | "interrupted" | "waiting" | "done" | "stuck" | "working";
  /** One or two words: the chip. */
  label: string;
  /** How long, in words, next to the chip. */
  detail: string;
  tone: CardTone;
  /** Still reporting: the dot pulses. */
  live: boolean;
  /** Something the owner may have to act on: the card opens itself. */
  attention: boolean;
};

export function runStatus(run: CoordinatorRunRow, now: number = Date.now()): RunStatus {
  const ago = eventAgo(run.updatedAt, now);
  if (run.state === "failed") return { key: "failed", label: "Failed", detail: ago, tone: "bad", live: false, attention: true };
  if (run.state === "interrupted")
    return {
      key: "interrupted",
      label: "Interrupted",
      detail: eventAgo(run.interruptedAt ?? run.updatedAt, now),
      tone: "wn",
      live: false,
      attention: true,
    };
  if (run.state === "waiting")
    return { key: "waiting", label: "Waiting on you", detail: `for ${ageLabel(run.updatedAt, now)}`, tone: "wn", live: false, attention: true };
  if (run.state === "done")
    return { key: "done", label: "Finished", detail: eventAgo(run.finishedAt ?? run.updatedAt, now), tone: "ok", live: false, attention: false };
  // A quiet run is not a failed run: say what is known (how long since it last reported), in amber, not red.
  if (run.stalled) return { key: "stuck", label: "Quiet", detail: `no update for ${ageLabel(run.updatedAt, now)}`, tone: "wn", live: false, attention: true };
  // The time beside "Working" is the time of its newest report when there is one, in the same words as the
  // timeline under it: the chip and the timeline can never disagree about how fresh the run is.
  const report = run.lastEvent?.at;
  return {
    key: "working",
    label: "Working",
    detail: report ? `last report ${eventAgo(report, now)}` : `updated ${ago}`,
    tone: "ai",
    live: true,
    attention: false,
  };
}

const CHIP: Record<RunEventType, { label: string; tone: CardTone }> = {
  started: { label: "Started", tone: "neutral" },
  progress: { label: "Progress", tone: "ai" },
  notice: { label: "Step done", tone: "inf" },
  ci: { label: "CI", tone: "inf" },
  "lock.acquired": { label: "Lock", tone: "wn" },
  "lock.released": { label: "Unlocked", tone: "neutral" },
  "release.staged": { label: "Staged", tone: "ac" },
  "release.live": { label: "Live", tone: "ok" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  interrupted: { label: "Interrupted", tone: "wn" },
  resumed: { label: "Resumed", tone: "ai" },
};
const OUTCOME: Record<string, "ok" | "bad" | "ai" | "wn"> = {
  ok: "ok",
  success: "ok",
  succeeded: "ok",
  passed: "ok",
  pass: "ok",
  green: "ok",
  done: "ok",
  completed: "ok",
  failed: "bad",
  failure: "bad",
  fail: "bad",
  error: "bad",
  errored: "bad",
  red: "bad",
  timed_out: "bad",
  cancelled: "wn",
  canceled: "wn",
  running: "ai",
  in_progress: "ai",
  pending: "wn",
  queued: "wn",
};

// ---- Did this step fail? ------------------------------------------------------------------------------------
// ONE rule, used by every surface (run card chip, item card chip, Activity ordering, timeline ticks). Structured
// state always wins: the event type, a state/status/conclusion field, an exit code, an `ok` flag or the CI stage
// of its pipeline. Only an event that carries none of those is read, and then only for an explicit failure that
// the sentence does not negate or say was fixed ("Fixed the 3 failing tests", "0 errors", "error handling").

/** Phrases that mention failure without reporting one: negated, counted as zero, or naming a thing. */
const NOT_A_FAILURE: RegExp[] = [
  // "0 errors", "no failures", "zero failing tests", "without errors", "none failed"
  /\b(?:0|no|zero|without|nothing|none|neither|never any)\s+(?:new\s+|more\s+|other\s+|lint\s+|type\s+|test\s+|build\s+)?(?:errors?|failures?|failed|failing(?:\s+(?:tests?|checks?))?|crash(?:es)?|timeouts?)\b/gi,
  // "not failing", "no longer fails", "didn't error", "won't break", "doesn't time out", "never crashed"
  /\b(?:not|no longer|never|didn't|did not|doesn't|does not|don't|won't|isn't|aren't|wasn't|weren't|hasn't|haven't|stopped)\s+(?:\w+\s+){0,2}?(?:fail\w*|error\w*|broke\w*|crash\w*|time[sd]?\s?out)\b/gi,
  // things named after failure: "error handling", "error messages", "failure mode", "fail-safe", "on error"
  /\berrors?[- ](?:handling|handler|handlers|messages?|states?|boundar(?:y|ies)|copy|text|pages?|toasts?|paths?|cases?|budget|codes?|reporting|logging|banner|tracking|rate)\b/gi,
  /\b(?:failures?|failing)[- ](?:modes?|cases?|paths?|handling|states?|scenarios?|branch(?:es)?)\b/gi,
  /\bfail[- ]?(?:safe|fast|over|closed|open)\b/gi,
  /\b(?:on|after an?|for|per|when an?|if an?)\s+(?:error|failure|timeout)\b/gi,
  /\b(?:can't|cannot|could not|couldn't|unable to)\s+reproduce\b/gi,
  // history, not news: "the previous run failed on a flake"
  /\b(?:previous|earlier|prior|old|last week's|yesterday's)\s+(?:\w+\s+){0,2}?(?:fail\w*|errors?|crash\w*|broke\w*)\b/gi,
];
/** A failure the sentence says was dealt with: "Fixed the failing tests", "resolved 2 errors", "retrying after a timeout". */
const DEALT_WITH =
  /\b(?:fix(?:ed|es|ing)?|resolv\w+|repair\w*|address\w*|handl\w+|patch\w*|silenc\w+|deflak\w+|quarantin\w+|skipp?\w*|debug\w*|investigat\w+|look(?:ed|ing)? into|reproduc\w+|retr(?:y|ied|ying)|rerun\w*|re-ran|cleared|clean(?:ed)? up|recover\w*|work(?:ed)? around|triag\w+|diagnos\w+|explain\w*|document\w*|test(?:ed|ing)? for|catch(?:es|ing)?|caught)\b[^.;!?\n]{0,60}?\b(?:fail\w*|errors?|broke\w*|crash\w*|time[sd]?\s?outs?|exceptions?|red)\b/gi;
/** Still broken overrides "fixed": "Fixed 2 of 3; 1 still failing". */
const STILL_BROKEN = /\bstill\s+(?:fail\w*|broke\w*|red|erroring|crash\w*|timing out)\b/i;
/** The attempt itself is what failed: "Retry failed", "Patch failed to apply", "Fix attempt crashed". */
const ATTEMPT_FAILED =
  /\b(?:retr(?:y|ies)|re-?run|fix(?:es)?|patch(?:es)?|repair|recovery|rebuild|attempt|migration|rollback)\s+(?:\w+\s+)?(?:failed|errored|crashed|timed out|broke)\b/i;
const SAYS_FAILED =
  /(?:^\s*(?:fail(?:ed|ure)?|error|fatal|panic|aborted)\b)|\b(?:fail(?:ed|s|ing|ures?)?|errors?|errored|erroring|timed\s?out|crash(?:ed|es|ing)?|broken|broke|exception|panick?(?:ed)?|abort(?:ed)?|blocked|denied|rejected|non-zero exit|exit(?:ed)?\s+(?:with\s+)?(?:code|status)\s+[1-9]\d*|could(?:n't| not)|cannot|can't|unable to|(?:is|are|went|turned|goes|stays?)\s+red)\b/i;
const SAYS_PASSED = /\b(?:pass(?:ed|ing|es)?|green|succeeded|successful(?:ly)?|all (?:\w+\s+){0,2}?(?:ok|good))\b/i;

function statedOutcome(payload: Record<string, unknown> | undefined, type: string): "ok" | "bad" | "neither" | null {
  if (!payload) return null;
  const pipeline = Array.isArray(payload.pipeline) ? (payload.pipeline as { stage?: unknown; state?: unknown }[]) : [];
  const stage = type === "ci" ? pipeline.find((p) => p?.stage === "ci") : undefined;
  for (const v of [stage?.state, payload.state, payload.status, payload.conclusion, payload.outcome, payload.result]) {
    if (typeof v !== "string") continue;
    const t = OUTCOME[v.toLowerCase().replace(/[\s-]+/g, "_")];
    if (t === "ok" || t === "bad") return t;
    if (t) return "neither"; // running/pending: a stated state that is neither, so the prose is not read
  }
  for (const v of [payload.exitCode, payload.exit_code, payload.exitStatus]) if (typeof v === "number") return v === 0 ? "ok" : "bad";
  if (typeof payload.ok === "boolean") return payload.ok ? "ok" : "bad";
  if (typeof payload.success === "boolean") return payload.success ? "ok" : "bad";
  return null;
}

/** Whether a sentence explicitly reports a failure (prose fallback only; prefer `stepOutcome`). */
export function proseSaysFailed(text: string | null | undefined): boolean {
  const said = (text ?? "").replace(/\s+/g, " ").trim();
  if (!said) return false;
  if (STILL_BROKEN.test(said) || ATTEMPT_FAILED.test(said)) return true;
  let rest = said;
  for (const re of NOT_A_FAILURE) rest = rest.replace(re, " ");
  rest = rest.replace(DEALT_WITH, " ");
  return SAYS_FAILED.test(rest);
}

/**
 * How a step turned out: "bad" (it failed), "ok" (it says it passed), or null (no verdict: a plain progress line).
 * The single source of truth for "Step failed" everywhere.
 */
export function stepOutcome(event: Pick<RunEvent, "type" | "summary" | "payload">): "ok" | "bad" | null {
  if (event.type === "failed") return "bad";
  if (event.type === "done" || event.type === "release.live") return "ok";
  const stated = statedOutcome(event.payload, event.type);
  if (stated) return stated === "neither" ? null : stated;
  if (event.type !== "notice" && event.type !== "progress" && event.type !== "ci") return null;
  if (proseSaysFailed(event.summary)) return "bad";
  if (event.type === "ci" && SAYS_PASSED.test(event.summary)) return "ok";
  return null;
}

/** True when this event reports a failed step (see `stepOutcome`). */
export const stepFailed = (event: Pick<RunEvent, "type" | "summary" | "payload"> | null | undefined) => !!event && stepOutcome(event) === "bad";

export function eventChip(event: Pick<RunEvent, "type" | "summary" | "payload">): { label: string; tone: CardTone } {
  const chip = CHIP[event.type] ?? { label: event.type, tone: "neutral" as const };
  const outcome = stepOutcome(event);
  if (event.type === "ci") return { ...chip, tone: outcome ?? "inf" };
  // A step or progress report that failed is not a calm blue line.
  if ((event.type === "notice" || event.type === "progress") && outcome === "bad")
    return { label: event.type === "notice" ? "Step failed" : chip.label, tone: "bad" };
  return chip;
}

/** The newest event of a run (by time; the later one in the list wins a tie), or the run's own last event. */
export function latestEvent(run: Pick<CoordinatorRunRow, "id" | "lastEvent">, events: readonly RunEvent[]): RunEvent | null {
  let latest: RunEvent | null = null;
  for (const event of events) {
    if (event.runId !== run.id) continue;
    if (!latest || Date.parse(event.at) >= Date.parse(latest.at)) latest = event;
  }
  return latest ?? run.lastEvent ?? null;
}

/**
 * A run's chip on any card. A run that went quiet right after reporting a failed step says so: the failure is
 * the news, the silence is the detail. (A failed step is not a failed run: the key stays "stuck".)
 */
export function cardStatus(run: CoordinatorRunRow, events: readonly RunEvent[], now: number = Date.now()): RunStatus & { failedStep: boolean } {
  const base = runStatus(run, now);
  const failedStep = base.key === "stuck" && stepFailed(latestEvent(run, events));
  return failedStep ? { ...base, label: "Step failed", tone: "bad", failedStep } : { ...base, failedStep };
}

/** What a waiting run needs from the owner: the open decision it raised, when there is one. */
export function runAsk(run: Pick<CoordinatorRunRow, "id">, decisions: readonly Decision[]): Decision | null {
  return decisions.filter((d) => d.state === "open" && d.runId === run.id).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null;
}

/**
 * Agent text as a sentence: "(no summary — status=failed: vendor portal timed out)" is a fallback some sources
 * write when they have nothing else; say what it says.
 */
export function tidyOutcome(text: string | null | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  const raw = /^\(?no summary\s*[—–-]\s*status=\w+:?\s*(.*?)\)?$/i.exec(flat);
  const said = raw ? raw[1]!.trim() : flat;
  return said ? said.charAt(0).toUpperCase() + said.slice(1) : "";
}

/** "Synced just now" / "Synced 3 minutes ago"; when a refresh fails, when the data on screen was last good. */
export function syncLine(updatedAt: number, failed: boolean, now: number = Date.now()): string {
  const fresh = now - updatedAt < 60_000;
  const age = !updatedAt ? "" : fresh ? "just now" : relativeTime(updatedAt, now);
  if (!failed) return age ? `Synced ${age}` : "";
  if (!updatedAt) return "Couldn't refresh";
  // Short enough to keep Retry on the same line on a phone; the exact time is in the line's tooltip.
  return `Couldn't refresh · last synced ${age}`;
}

/**
 * What a waiting run needs from the owner, in the best words available: the open decision it raised, else what
 * the agent last summarised (a waiting run's summary is normally its ask).
 */
export function runNeeds(
  run: Pick<CoordinatorRunRow, "id" | "state" | "summary" | "title">,
  decisions: readonly Decision[],
): { text: string; decision: Decision | null } | null {
  if (run.state !== "waiting") return null;
  const decision = runAsk(run, decisions);
  const text = decision ? decision.question : tidyOutcome(run.summary);
  return text && text.toLowerCase() !== run.title.trim().toLowerCase() ? { text, decision } : null;
}

/**
 * Runs that need a look, most in need first: one that failed, then one whose last report says a step failed,
 * then the rest by how recently they went quiet. Silence alone never outranks a reported failure.
 */
export function byNeed(runs: readonly CoordinatorRunRow[], events: readonly RunEvent[]): CoordinatorRunRow[] {
  const rank = (run: CoordinatorRunRow) => (run.state === "failed" ? 0 : stepFailed(latestEvent(run, events)) ? 1 : 2);
  return [...runs].sort((x, y) => rank(x) - rank(y) || Date.parse(y.updatedAt) - Date.parse(x.updatedAt) || y.seq - x.seq);
}

export type BackgroundWork = {
  record: ExecutionRecord;
  /** The tracked run (R-n) this work is, when it is one: its state and timeline are the authority. */
  run?: CoordinatorRunRow;
  /** The sub-agent record that can take Steer / Stop for this work. */
  control?: ExecutionRecord;
};
const workTitle = (title: string) =>
  title
    .replace(/^Subagent:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const informative = (r: ExecutionRecord) => (r.state === "unknown" ? 0 : 2) + (r.error || r.summary || r.step ? 1 : 0);
const timeOf = (at?: string | null) => {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : null;
};
const WINDOW_SLACK_MS = 60_000;
/**
 * A shared title is only a hint that a record and a tracked run are the same work. It is no hint at all when one
 * ended before the other began: a weekly job reuses its title, and last week's sub-agent is not this week's run.
 * A record that carries no start time is placed by its last update.
 */
function sameWindow(record: ExecutionRecord, run: CoordinatorRunRow): boolean {
  const recordStart = timeOf(record.startedAt ?? record.updatedAt);
  const recordEnd = timeOf(record.endedAt);
  const runStart = timeOf(run.startedAt);
  const runEnd = timeOf(run.finishedAt);
  if (recordEnd !== null && runStart !== null && recordEnd < runStart - WINDOW_SLACK_MS) return false;
  if (runEnd !== null && recordStart !== null && runEnd < recordStart - WINDOW_SLACK_MS) return false;
  return true;
}
/** Where Steer and Stop for a sub-agent record are addressed: Hermes' own handle when known, else the record's id. */
export const controlHandle = (record: Pick<ExecutionRecord, "id" | "subagentId">) => record.subagentId ?? record.id;
/** The same sub-agent seen through two sources (its child session, its delegation handle). */
const sameAgent = (a: ExecutionRecord, b: ExecutionRecord) =>
  a.id === b.id || controlHandle(a) === controlHandle(b) || (!!a.childSessionId && a.childSessionId === b.childSessionId);
/**
 * One card per piece of work. A conversation's background work arrives from several sources (the sub-agent
 * itself, its run registration, the R-n run), and they describe the same thing with different freshness:
 * records that are the same sub-agent or the same tracked run, or share a title while one of them has no
 * status, are one card.
 *
 * Steer and Stop go to `control`, so a card must never show one sub-agent and control another, and neither
 * what a card controls nor which run it shows may depend on the order the records arrive in (it changes on
 * every poll):
 * - records are grouped into sub-agents first (every view of one agent, however they are linked);
 * - a tracked run is a sub-agent's only when exactly one sub-agent can be it: the one that is still going
 *   (a failed attempt and its retry share a title; the run is the retry's), else the one that has ended.
 *   A run that two could both be is neither's: each keeps its own card and controls, and the run is shown
 *   only by its own record, if it has one. A sub-agent nothing is known about yet may fold into the run's card;
 * - within a card the controls follow the best-informed record of the sub-agent it is about.
 */
export function mergeBackgroundWork(records: readonly ExecutionRecord[], runs: readonly CoordinatorRunRow[]): BackgroundWork[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const byTitle = new Map<string, CoordinatorRunRow[]>();
  for (const run of [...runs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id))) {
    const key = workTitle(run.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), run]);
  }
  const runOf = (record: ExecutionRecord) =>
    (record.source === "subagent" ? undefined : byId.get(record.id)) ?? byTitle.get(workTitle(record.title))?.find((r) => sameWindow(record, r));
  // Which sub-agent each record is. "Same agent" links views pairwise (A~B by handle, B~C by child session), so
  // the groups are closed over those links before anything is counted.
  const subs = records.filter((r) => r.source === "subagent");
  const agentOf = new Map<ExecutionRecord, number>();
  subs.forEach((record, i) => {
    agentOf.set(record, i);
    for (const other of subs.slice(0, i)) {
      const from = agentOf.get(record)!;
      const to = agentOf.get(other)!;
      if (from === to || !sameAgent(record, other)) continue;
      for (const [member, id] of agentOf) if (id === from) agentOf.set(member, to);
    }
  });
  const known = new Set(subs.filter((r) => r.state !== "unknown").map((r) => agentOf.get(r)!));
  const going = new Map<string, Set<number>>();
  const ended = new Map<string, Set<number>>();
  for (const record of subs) {
    if (record.state === "unknown") continue;
    const run = runOf(record);
    if (!run) continue;
    const claims = isActiveExec(record) ? going : ended;
    claims.set(run.id, (claims.get(run.id) ?? new Set<number>()).add(agentOf.get(record)!));
  }
  const ownRun = (record: ExecutionRecord, matched: CoordinatorRunRow | undefined) => {
    if (!matched) return undefined;
    const agent = agentOf.get(record)!;
    const live = going.get(matched.id);
    const claimants = live?.size ? live : ended.get(matched.id);
    // Nothing is known about this sub-agent yet: it claims nothing, and may fold into the card of a run that
    // is not contested.
    if (!known.has(agent)) return (claimants?.size ?? 0) < 2 ? matched : undefined;
    return claimants?.size === 1 && claimants.has(agent) ? matched : undefined;
  };
  // One answer per sub-agent, whichever of its views could be matched to the run (a view that carries no start
  // time may not be): the card must not gain or lose its run with the order the views arrive in.
  const runOfAgent = new Map<number, CoordinatorRunRow>();
  for (const record of subs) {
    const agent = agentOf.get(record)!;
    const run = ownRun(record, runOf(record));
    const prior = runOfAgent.get(agent);
    const newer = !!run && !!prior && (Date.parse(run.updatedAt) - Date.parse(prior.updatedAt) || run.id.localeCompare(prior.id)) > 0;
    if (run && (!prior || newer)) runOfAgent.set(agent, run);
  }
  // Cards are built from what is known first: sub-agents with a known state (every view of each), then other
  // records that report a state. Only then do records nothing is known about fold in. They add nothing to a
  // card that knows more, so the cards, what each shows and what each controls are the same in any order of
  // the records; only the order of the cards follows the order of the records.
  const phase = (record: ExecutionRecord) => (record.source === "subagent" ? (known.has(agentOf.get(record)!) ? 0 : 2) : record.state === "unknown" ? 2 : 1);
  // Within a phase the records are taken in key order, not arrival order, so the result is a function of the
  // set of records alone; `index` is kept only to put the finished cards in the order the records came in.
  const queue = records
    .map((record, index) => ({ record, index }))
    .sort((x, y) => phase(x.record) - phase(y.record) || x.record.key.localeCompare(y.record.key) || x.index - y.index);
  // The better-informed record; between equals, always the same one.
  const better = (a: ExecutionRecord, b: ExecutionRecord) => (informative(a) - informative(b) || b.key.localeCompare(a.key)) > 0;
  const out: (BackgroundWork & { titles: Set<string>; agent?: number; index: number })[] = [];
  for (const { record, index } of queue) {
    const title = workTitle(record.title);
    const sub = record.source === "subagent";
    const agent = agentOf.get(record);
    const run = sub ? runOfAgent.get(agent!) : runOf(record);
    // A view of a sub-agent with a known state joins that sub-agent's card or its run's, never another card
    // that merely has its title.
    const folds = !run && !(sub && known.has(agent!));
    const byTitle = folds
      ? out
          .filter((w) => !w.run && w.titles.has(title) && (w.record.state === "unknown" || record.state === "unknown"))
          .sort((x, y) => x.record.key.localeCompare(y.record.key))[0]
      : undefined;
    const same = (sub ? out.find((w) => w.agent === agent) : undefined) ?? (run ? out.find((w) => w.run?.id === run.id) : undefined) ?? byTitle;
    // Cannot happen while run ownership is decided above; kept so that no change to the matching can ever fold
    // two sub-agents that each report a real state into one card.
    const rival = sub && !!same?.control && same.agent !== agent && same.control.state !== "unknown" && record.state !== "unknown";
    if (!same || rival) {
      out.push({ record, run: rival ? undefined : run, control: sub ? record : undefined, agent: sub ? agent : undefined, titles: new Set([title]), index });
      continue;
    }
    same.index = Math.min(same.index, index);
    same.titles.add(title);
    if (better(record, same.record)) same.record = record;
    if (sub && (!same.control || better(record, same.control))) {
      same.control = record;
      same.agent = agent;
    }
  }
  return out.sort((x, y) => x.index - y.index).map(({ titles: _titles, agent: _agent, index: _index, ...work }) => work);
}

/**
 * A card's identity on screen: where its controls are addressed, else the tracked run, else the record. What is
 * typed into a card, or a stop being confirmed on it, stays with that address through reorders and new sources,
 * and a card whose controls would reach anything else is a new card. (Each kind has its own prefix: a handle
 * can never be mistaken for a run or a record key.)
 */
export function workKey(work: BackgroundWork): string {
  if (work.control) return `agent:${controlHandle(work.control)}`;
  return work.run ? `run:${work.run.id}` : `record:${work.record.key}`;
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
/** The event's own words, or nothing when it only repeats the run's title (a "started" event usually does). */
export function eventText(event: Pick<RunEvent, "summary">, runTitle: string): string {
  const summary = event.summary.replace(/\s+/g, " ").trim();
  return flat(summary) === flat(runTitle) ? "" : summary;
}

/** Newest first, one row per event id. */
export function timelineOf(...lists: (readonly RunEvent[] | undefined)[]): RunEvent[] {
  const seen = new Map<string, RunEvent>();
  for (const list of lists) for (const event of list ?? []) seen.set(event.id, event);
  return [...seen.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}

/** How long ago, measured against now: "just now", "12 min ago", "3 h ago", "2 d ago". */
export function eventAgo(at: string, now: number = Date.now()): string {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return "";
  return now - then < 60_000 ? "just now" : `${ageLabel(at, now)} ago`;
}

export type SinceCounts = { decisions: number; runs: number; failed?: number; stuck?: number; waiting?: number; finished?: number };
export type SinceChip = { key: "failed" | "decisions" | "waiting" | "stuck" | "finished" | "runs"; label: string; tone: CardTone; tab: "needs" | "running" };
const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** What changed while the owner was away, worst first; each chip jumps to where it lives. */
export function sinceChips(counts: SinceCounts): SinceChip[] {
  const chips: SinceChip[] = [];
  const { failed = 0, stuck = 0, waiting = 0, finished = 0 } = counts;
  if (failed) chips.push({ key: "failed", label: `${failed} failed`, tone: "bad", tab: "running" });
  if (counts.decisions) chips.push({ key: "decisions", label: count(counts.decisions, "new decision", "new decisions"), tone: "ac", tab: "needs" });
  if (waiting) chips.push({ key: "waiting", label: `${waiting} waiting on you`, tone: "wn", tab: "running" });
  if (stuck) chips.push({ key: "stuck", label: `${stuck} went quiet`, tone: "wn", tab: "running" });
  if (finished) chips.push({ key: "finished", label: `${finished} finished`, tone: "ok", tab: "running" });
  const rest = Math.max(0, counts.runs - failed - stuck - waiting - finished);
  if (rest) chips.push({ key: "runs", label: count(rest, "run updated", "runs updated"), tone: "ai", tab: "running" });
  return chips;
}

/** The run half of the breakdown: what each top-level run that moved since `sinceAt` is doing now. */
export function sinceRunCounts(runs: readonly CoordinatorRunRow[], sinceAt: number): Omit<SinceCounts, "decisions"> {
  const moved = runs.filter((r) => Date.parse(r.updatedAt) > sinceAt);
  const failed = moved.filter((r) => r.state === "failed").length;
  const waiting = moved.filter((r) => r.state === "waiting").length;
  const finished = moved.filter((r) => r.state === "done").length;
  const stuck = moved.filter((r) => r.stalled && r.state === "running").length;
  return { runs: moved.length, failed, stuck, waiting, finished };
}

export type PulseTick = { id: string; at: number; tone: CardTone };
/**
 * A run's reports laid out in time, from its start to now (or to when it finished): each tick is one event at
 * its place (0..1) in that span. The spacing is the story: a steady run has even ticks to the right edge, a run
 * that went quiet has a gap after its last one.
 */
export function runPulse(run: Pick<CoordinatorRunRow, "startedAt" | "finishedAt">, events: readonly RunEvent[], now: number = Date.now()): PulseTick[] {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return [...events]
    .filter((e) => Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-24)
    .map((e) => ({ id: e.id, at: Math.min(1, Math.max(0, (Date.parse(e.at) - start) / (end - start))), tone: eventChip(e).tone }));
}
