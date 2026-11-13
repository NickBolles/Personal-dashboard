/**
 * What the item page and the project / area page draw (app/(shell)/areas/WorkView.tsx): every run, job and report
 * on an item as ONE list of rows in the shared vocabulary (lib/work-words.ts), the one thing the page leads with
 * ("Now"), and a project's three groups rolled up from its items. Pure and client-safe.
 */
import { isStalled, whoLabel, type ExternalRun, type ItemAgentInfo } from "@/lib/agent-runs";
import { AI_KIND_LABEL, KIND_VERB, TERMINAL_JOB_STATES, type JobView, type ReportView } from "@/lib/ai";
import type { Decision } from "@/lib/cw-decisions";
import { dueLabel, itemCardModel, subtreeIds, type ItemHeadline } from "@/lib/coordinator/item-card";
import { ageLabel } from "@/lib/coordinator/needs";
import { tidyOutcome } from "@/lib/coordinator/run-card";
import type { CoordinatorRunRow } from "@/lib/coordinator/runs-view";
import { isOldFailure } from "@/lib/coordinator/status";
import { isClosed, isContainer, rollup, STATUS_LABELS, type ItemPrimary, type WorkItem } from "@/lib/work";
import { WORK_GROUP, WORK_RANK, workStateOfLive, type WorkGroup, type WorkState } from "@/lib/work-words";

/** A failed AI job stays on the page this long (then it is history: Activity has it). */
export const FAILED_JOB_SHOWN_MS = 3_600_000;

type RowBase = {
  key: string;
  state: WorkState;
  title: string;
  /** Line two after the state word: what it waits for, what it last said, why it failed. */
  note: string;
  /** When it last moved. */
  at: string | null;
};
export type RunWorkRow = RowBase & {
  kind: "run";
  /** "R-n" once the run is tracked (it always is after the server's first read). */
  refId: string | null;
  run: ExternalRun;
  /** The open decision this run raised, when it waits on one. */
  decision: Pick<Decision, "ref" | "question"> | null;
};
export type JobWorkRow = RowBase & { kind: "job"; job: JobView };
export type ReportWorkRow = RowBase & { kind: "report"; report: ReportView };
/** Work in a linked conversation that no run or job row accounts for (a plain chat run). */
export type ChatWorkRow = RowBase & { kind: "chat"; sessionId: string | null; approval: boolean };
export type ItemWorkRow = RunWorkRow | JobWorkRow | ReportWorkRow | ChatWorkRow;

/** A registered run's state in the shared words. An interrupted run waits to be resumed: it reads Stalled. */
export function runWorkState(run: Pick<ExternalRun, "state" | "updatedAt">, now: number, stalled = false): WorkState {
  if (run.state === "waiting") return "needs";
  if (run.state === "interrupted") return "stalled";
  if (run.state === "failed") return "failed";
  if (run.state === "done") return "done";
  return stalled || isStalled(run, now) ? "stalled" : "working";
}

const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

function runNote(run: ExternalRun, state: WorkState, decision: RunWorkRow["decision"], tracked: CoordinatorRunRow | undefined, now: number): string {
  const said = tidyOutcome(run.summary);
  if (state === "needs") return decision ? `answer ${decision.ref}` : said;
  if (state === "stalled") return run.state === "interrupted" ? "interrupted, waiting to be resumed" : `no report for ${ageLabel(run.updatedAt, now)}`;
  if (state === "working") return flat(tracked?.lastEvent?.summary) || said;
  return said;
}

function jobRow(job: JobView): JobWorkRow {
  const title = AI_KIND_LABEL[job.kind];
  const at = job.finishedAt ?? job.startedAt ?? job.createdAt;
  const base = { kind: "job" as const, key: `job:${job.id}`, title, at, job };
  switch (job.state) {
    case "waiting_approval":
      return { ...base, state: "needs", note: "Hermes needs approval" };
    case "budget_blocked":
      return { ...base, state: "needs", note: "waiting for budget" };
    case "failed":
      return { ...base, state: "failed", note: flat(job.errorMessage) || "unknown error" };
    case "cancelling":
      return { ...base, state: "working", note: "stopping" };
    case "queued":
      return { ...base, state: "working", note: "queued" };
    default:
      return { ...base, state: "working", note: KIND_VERB[job.kind].toLowerCase() };
  }
}

const newestFirst = (a: RowBase, b: RowBase) => (b.at ?? "").localeCompare(a.at ?? "");

/**
 * Every piece of agent work on one item, most in need first: registered runs (R-n, sub-agents folded in), AI jobs
 * still going or just failed, finished reports, and (only when none of those explains the item's live state) the
 * linked conversation's own run.
 */
export function itemWorkRows(input: {
  info?: ItemAgentInfo | null;
  /** Tracked runs (the R-n list): gives a registered run its ref, its stalled flag and its last event. */
  runs?: readonly CoordinatorRunRow[];
  decisions?: readonly Decision[];
  jobs?: readonly JobView[];
  reports?: readonly ReportView[];
  now?: number;
}): ItemWorkRow[] {
  const now = input.now ?? Date.now();
  const tracked = new Map((input.runs ?? []).map((r) => [r.id, r]));
  const rows: ItemWorkRow[] = [];
  for (const run of input.info?.agentRuns ?? []) {
    const row = tracked.get(run.id);
    const state = runWorkState(run, now, row?.stalled);
    const asked =
      state === "needs"
        ? ((input.decisions ?? []).filter((d) => d.state === "open" && d.runId === run.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null)
        : null;
    const decision = asked ? { ref: asked.ref, question: asked.question } : null;
    rows.push({
      kind: "run",
      key: `run:${run.id}`,
      state,
      refId: row?.ref ?? null,
      title: run.title,
      note: runNote(run, state, decision, row, now),
      at: run.updatedAt,
      run,
      decision,
    });
  }
  for (const job of input.jobs ?? []) {
    const recentFailure = job.state === "failed" && now - Date.parse(job.finishedAt ?? job.createdAt) < FAILED_JOB_SHOWN_MS;
    if (!TERMINAL_JOB_STATES.includes(job.state) || recentFailure) rows.push(jobRow(job));
  }
  for (const report of input.reports ?? []) {
    if (report.archivedAt) continue;
    const kind = report.kind === "summarize" ? "Summary draft" : AI_KIND_LABEL[report.kind];
    const sources = report.sourceCount ? `${report.sourceCount} source${report.sourceCount === 1 ? "" : "s"}` : "";
    rows.push({
      kind: "report",
      key: `report:${report.id}`,
      state: "done",
      title: report.title,
      note: [kind, sources, report.supersededBy ? "earlier version" : ""].filter(Boolean).join(" · "),
      at: report.createdAt,
      report,
    });
  }
  const live = input.info ? workStateOfLive(input.info.live) : null;
  if (input.info && live && !rows.some((r) => WORK_GROUP[r.state] === WORK_GROUP[live])) {
    const who = input.info.who && input.info.who.kind !== "person" ? whoLabel(input.info.who) : "";
    rows.push({
      kind: "chat",
      key: "chat",
      state: live,
      title: input.info.sessionId ? "Conversation" : "Agent work",
      note: [input.info.approval ? "approval" : "", who].filter(Boolean).join(" · "),
      at: input.info.liveAt,
      sessionId: input.info.sessionId,
      approval: !!input.info.approval,
    });
  }
  const older = (row: ItemWorkRow) => Number(row.kind === "report" && !!row.report.supersededBy);
  return rows.sort((a, b) => WORK_RANK[a.state] - WORK_RANK[b.state] || older(a) - older(b) || newestFirst(a, b));
}

/** Rows split into the three groups every list uses. Superseded reports sit last inside Done. */
export function groupWork<R extends { state: WorkState }>(rows: readonly R[]): Record<WorkGroup, R[]> {
  const groups: Record<WorkGroup, R[]> = { needs: [], working: [], done: [] };
  for (const row of rows) groups[WORK_GROUP[row.state]].push(row);
  return groups;
}

/**
 * The one thing the item page leads with, in the item card's priority (Needs you first):
 * - "escalation": the escalation banner has a decision or a failed / stalled run to show;
 * - "pointer": something else on the item waits on the owner (an open decision, a row under Needs you). The slot
 *   names it with chips that jump to it; it is drawn once, where it lives;
 * - "action": nothing needs the owner, so the page shows its one primary action for the item's state.
 */
export type ItemNow =
  | { kind: "escalation" }
  | { kind: "pointer"; decisions: Pick<Decision, "ref" | "question">[]; rows: ItemWorkRow[] }
  | { kind: "action"; action: ItemPrimary };

export function itemNow(input: {
  itemId: string;
  escalation: boolean;
  action: ItemPrimary;
  rows: readonly ItemWorkRow[];
  decisions?: readonly Decision[];
}): ItemNow {
  if (input.escalation) return { kind: "escalation" };
  const decisions = (input.decisions ?? [])
    .filter((d) => d.state === "open" && d.itemId === input.itemId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((d) => ({ ref: d.ref, question: d.question }));
  const rows = input.rows.filter((r) => WORK_GROUP[r.state] === "needs");
  if (decisions.length || rows.length) return { kind: "pointer", decisions, rows };
  return { kind: "action", action: input.action };
}

/** "6 changes · last one 2 d ago": the Log line. Null when nothing has been recorded yet. */
export function logLine(events: readonly { at: string }[], now: number = Date.now()): string | null {
  if (!events.length) return null;
  const last = events.reduce((m, e) => (e.at > m ? e.at : m), events[0]!.at);
  const ms = now - Date.parse(last);
  const ago = !Number.isFinite(ms) || ms < 60_000 ? "just now" : `${ageLabel(last, now)} ago`;
  return `${events.length} change${events.length === 1 ? "" : "s"} · last one ${ago}`;
}

// ---- Project / area page ---------------------------------------------------------------------------------------

const HEADLINE_STATE: Record<ItemHeadline["key"], WorkState | "idle"> = {
  needs: "needs",
  failed: "failed",
  waiting: "needs",
  stuck: "stalled",
  working: "working",
  status: "idle",
};

export type RollupDecisionRow = { kind: "decision"; key: string; refId: string; title: string; itemId: string; itemTitle: string; age: string };
export type RollupRunRow = { kind: "run"; key: string; refId: string; state: WorkState; title: string; note: string; itemId: string; itemTitle: string };
export type RollupItemRow = {
  key: string;
  item: WorkItem;
  /** The item's one headline in the shared words; "idle" when nothing is happening to it, "done" once closed. */
  state: WorkState | "idle";
  /** What line two points at when the headline is not the item's own status: its D-n or R-n. */
  refs: string[];
  /** The item's own stage, when it has moved past the default. */
  status: string;
  next: string;
  due: string;
  /** Child projects: "2 of 5 done". */
  progress: string;
};
export type ContainerRollup = {
  /** "5 items · 2 done" (areas lead with their projects). */
  meta: string;
  needs: (RollupDecisionRow | RollupRunRow)[];
  working: RollupRunRow[];
  items: RollupItemRow[];
  done: RollupItemRow[];
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * A project or area page: its meta line, then the same three groups as every list, rolled up from everything under
 * it. Needs you = open decisions (oldest first), then failed and stalled work. Working = runs still reporting.
 * Items = its direct children still open, each with its one headline. Done = the closed ones, as a count.
 */
export function containerRollup(input: {
  item: WorkItem;
  items: readonly WorkItem[];
  agents?: Record<string, ItemAgentInfo>;
  runs?: readonly CoordinatorRunRow[];
  decisions?: readonly Decision[];
  now?: number;
}): ContainerRollup {
  const now = input.now ?? Date.now();
  const live = input.items.filter((i) => !i.archived);
  const byId = new Map(live.map((i) => [i.id, i]));
  const scope = subtreeIds(live, input.item.id);
  const titleOf = (id: string) => byId.get(id)?.title ?? "";
  const r = rollup(live, input.item.id);
  const isArea = input.item.parentId === null;
  const meta = [isArea ? plural(r.containers, "project") : "", plural(r.total, "item"), r.done ? `${r.done} done` : ""].filter(Boolean).join(" · ");

  const decisions = (input.decisions ?? [])
    .filter((d) => d.state === "open" && scope.has(d.itemId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(
      (d): RollupDecisionRow => ({
        kind: "decision",
        key: `d:${d.ref}`,
        refId: d.ref,
        title: d.question,
        itemId: d.itemId,
        itemTitle: titleOf(d.itemId) || d.itemTitle || "",
        age: ageLabel(d.createdAt, now),
      }),
    );
  // Sub-agents are folded into their parent run: one row per piece of work.
  const top = (input.runs ?? []).filter((run) => scope.has(run.itemId) && !run.parentRunId);
  const runRow = (run: CoordinatorRunRow): RollupRunRow => {
    const state = runWorkState(run, now, run.stalled);
    const asked = state === "needs" ? (input.decisions ?? []).find((d) => d.state === "open" && d.runId === run.id) : undefined;
    const said = tidyOutcome(run.summary);
    const note =
      state === "needs"
        ? asked
          ? `answer ${asked.ref}`
          : said
        : state === "stalled"
          ? run.state === "interrupted"
            ? "interrupted, waiting to be resumed"
            : `no report for ${ageLabel(run.updatedAt, now)}`
          : state === "working"
            ? flat(run.lastEvent?.summary) || said
            : said;
    return { kind: "run", key: `r:${run.id}`, refId: run.ref, state, title: run.title, note, itemId: run.itemId, itemTitle: titleOf(run.itemId) };
  };
  const attention = top
    .filter((run) => (run.state === "failed" ? !isOldFailure(run, now) : run.state !== "done"))
    .map(runRow)
    .filter((row) => WORK_GROUP[row.state] === "needs")
    .sort((a, b) => WORK_RANK[a.state] - WORK_RANK[b.state]);
  const working = top
    .filter((run) => run.state === "running")
    .map(runRow)
    .filter((row) => row.state === "working");

  const kids = live.filter((i) => i.parentId === input.item.id);
  const itemRow = (item: WorkItem): RollupItemRow => {
    const container = isContainer(item);
    const closed = isClosed(item.status) && !container && item.kind !== "conversation";
    const model = itemCardModel({ item, items: live, agent: input.agents?.[item.id] ?? null, runs: input.runs, decisions: input.decisions, now });
    const state = closed ? "done" : HEADLINE_STATE[model.headline.key];
    const refs =
      model.headline.key === "needs"
        ? model.decisions.slice(0, 2).map((d) => d.ref)
        : model.headline.key === "status"
          ? []
          : [...model.attention, ...model.working].slice(0, 1).map((run) => run.ref);
    const kidRollup = container ? rollup(live, item.id) : null;
    return {
      key: item.id,
      item,
      state,
      refs,
      status: item.status === "captured" || item.kind === "conversation" ? "" : STATUS_LABELS[item.status],
      next: closed ? "" : model.next,
      due: dueLabel(item.targetDate, item.status, now)?.label ?? "",
      progress: kidRollup && kidRollup.total ? `${kidRollup.done} of ${kidRollup.total} done` : "",
    };
  };
  const rows = kids.map(itemRow);
  return {
    meta,
    needs: [...decisions, ...attention],
    working,
    items: rows.filter((row) => row.state !== "done"),
    done: rows.filter((row) => row.state === "done"),
  };
}
