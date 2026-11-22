/**
 * The task list (task threads, step 3): one read and one shape for In flight, every bot's Tasks tab, a project's
 * Tasks section and the review queue. Only the scope and the view differ. Pure and client-safe; the server
 * (server/work/tasks.ts) gathers the facts and calls `buildTaskList`.
 *
 *   GET /api/work/tasks?scope=all|<areaId>|<projectId>&view=flight|all|review  -> TaskListResponse  (cap work.use)
 *
 * One row per task. Runs, questions and chats never appear as rows of their own: a run is how a task got its
 * state, a question is why it needs you, a chat is where you open it.
 */
import type { ItemAgentInfo } from "@/lib/agent-runs";
import { eventChip, eventText, tidyOutcome, type CardTone } from "@/lib/coordinator/run-card";
import type { CoordinatorRunRow } from "@/lib/coordinator/runs-view";
import type { Decision } from "@/lib/cw-decisions";
import type { RunEvent } from "@/lib/cw-runs";
import { rowChoices, viewOfDecision, type DecisionView } from "@/lib/decision-view";
import { primarySessionOf } from "@/lib/task-chat";
import { isInFlight, taskState, TASK_RANK, type TaskRunFact, type TaskStatus } from "@/lib/task-state";
import { isClosed, type WorkItem } from "@/lib/work";

export const TASK_VIEWS = ["flight", "all", "review"] as const;
export type TaskView = (typeof TASK_VIEWS)[number];

/** One thing that happened on a task: its type, what was said, when. Newest first wherever it is listed. */
export type TaskMoment = { id: string; label: string; tone: CardTone; text: string; at: string };

export type TaskPr = { label: string; url: string | null; state: string | null; checks: string | null };

/** What is inside a project, by state. `total` counts open and closed tasks; `done` the closed ones. */
export type TaskRollup = { total: number; done: number; needs: number; failed: number; stalled: number; working: number; review: number };

export type TaskRow = TaskStatus & {
  id: string;
  title: string;
  /** "Portfolio › Storefront": where it sits, without its own title. */
  path: string;
  areaId: string | null;
  parentId: string | null;
  /** A task with tasks inside. */
  project: boolean;
  /** Who has it: the agent working on it, else its assignee or the channel's coordinator. */
  who: string | null;
  /** The newest things that happened (at most three): the row shows the latest fading into the one before. */
  activity: TaskMoment[];
  /** The open question it waits on, when there is one. */
  question: DecisionView | null;
  /** Its pull request, when it has one (the review queue shows merged and check state). */
  pr: TaskPr | null;
  /** The task's chat (its primary), when it has one. */
  chat: string | null;
  can: { steer: boolean; stop: boolean; retry: boolean };
  /** Projects: what is inside. */
  rollup?: TaskRollup;
  /** Projects in the All view: the rows inside, two levels at most. */
  children?: TaskRow[];
  /** Rows inside that this list does not carry (deeper levels): open the project to see them. */
  more?: number;
};

export type TaskGroup = {
  /** The channel (area), or in the review queue the project the tasks belong to. */
  id: string;
  title: string;
  /** Rows in this group that need you. */
  needs: number;
  rows: TaskRow[];
};

export type TaskListResponse = {
  view: TaskView;
  scope: string;
  groups: TaskGroup[];
  /** Tasks in scope that need you: the navigation badge, and the number of Needs you rows. */
  needs: number;
  /** Finished and unreviewed work in scope: one row with a count and the oldest age. */
  review: { count: number; projects: number; oldestAt: string | null } | null;
  /** Closed since the owner last looked. */
  done: { count: number; titles: string[] } | null;
  /** Open tasks in scope (the All view's size). */
  open: number;
  /** One project's page (`scope` is a project): what is inside it by state, who is working in it, what happened last. */
  project?: {
    rollup: TaskRollup;
    /** Every task being worked on anywhere inside the project. */
    atWork: { id: string; title: string; who: string | null; since: string | null }[];
    /** The newest things that happened on any task inside it. */
    timeline: (TaskMoment & { taskId: string; task: string })[];
  };
  fetchedAt: string;
};

export type TaskSource = {
  /** The owner's tree, archived rows already left out. */
  items: readonly WorkItem[];
  runs: readonly CoordinatorRunRow[];
  events: readonly RunEvent[];
  /** Open decisions. */
  decisions: readonly Decision[];
  info: Readonly<Record<string, ItemAgentInfo>>;
  /** When the owner last looked at In flight. */
  lastLooked: string | null;
  /** A display name for an agent profile ("devchief" -> "Dev coordinator"); the profile itself when unknown. */
  name?: (profile: string) => string;
};

/** A task is work: not a channel, not a filed conversation. */
export const isTask = (i: Pick<WorkItem, "kind" | "parentId">) => i.parentId !== null && i.kind !== "area" && i.kind !== "conversation";

/** How many activity lines a row carries. */
export const ROW_MOMENTS = 3;
/** Lines of a project's own timeline (across its tasks). */
export const PROJECT_MOMENTS = 6;
/** Levels a project opens in place. */
export const PROJECT_LEVELS = 2;

const flat = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
const recent = (a: { since: string | null }, b: { since: string | null }) => (b.since ?? "").localeCompare(a.since ?? "");
export const byTaskRank = (a: Pick<TaskRow, "state" | "since">, b: Pick<TaskRow, "state" | "since">) => TASK_RANK[a.state] - TASK_RANK[b.state] || recent(a, b);

const emptyRollup = (): TaskRollup => ({ total: 0, done: 0, needs: 0, failed: 0, stalled: 0, working: 0, review: 0 });

/** "3 of 10 done · 2 need you · 2 working · 1 stalled": a project's roll-up as one line. */
export function rollupLine(r: TaskRollup): string {
  const parts = [`${r.done} of ${r.total} done`];
  if (r.needs) parts.push(r.needs === 1 ? "1 needs you" : `${r.needs} need you`);
  if (r.failed) parts.push(`${r.failed} failed`);
  if (r.working) parts.push(`${r.working} working`);
  if (r.stalled) parts.push(`${r.stalled} stalled`);
  if (r.review) parts.push(`${r.review} to review`);
  return parts.join(" · ");
}

/** A run event as a timeline line; null when it only repeats the run's title. */
export function momentOf(event: RunEvent, runTitle: string): TaskMoment | null {
  const chip = eventChip(event);
  const text = eventText(event, runTitle);
  if (!text && (event.type === "progress" || event.type === "notice")) return null;
  return { id: event.id, label: chip.label, tone: chip.tone, text, at: event.at };
}

const asked = (d: Pick<Decision, "id" | "question" | "createdAt">): TaskMoment => ({
  id: `asked:${d.id}`,
  label: "Asked you",
  tone: "wn",
  text: flat(d.question),
  at: d.createdAt,
});

/**
 * Everything known about a task's activity, newest first: its runs' reports and the questions it raised.
 * `events` come oldest first (as the store lists them), so of two written in the same instant the later one leads.
 */
export function taskMoments(runs: readonly CoordinatorRunRow[], events: readonly RunEvent[], decisions: readonly Decision[]): TaskMoment[] {
  const titles = new Map(runs.map((r) => [r.id, r.title]));
  const seen = new Set<string>();
  const out: { moment: TaskMoment; order: number }[] = [];
  const add = (event: RunEvent | undefined) => {
    if (!event || seen.has(event.id) || !titles.has(event.runId)) return;
    seen.add(event.id);
    const moment = momentOf(event, titles.get(event.runId)!);
    if (moment) out.push({ moment, order: out.length });
  };
  for (const event of events) add(event);
  for (const run of runs) add(run.lastEvent);
  for (const d of decisions) out.push({ moment: asked(d), order: out.length });
  return out.sort((a, b) => Date.parse(b.moment.at) - Date.parse(a.moment.at) || b.order - a.order).map((x) => x.moment);
}

/** What a row shows of it: the newest lines that say something (a bare "Started" is for the full timeline). */
export function rowMoments(moments: readonly TaskMoment[]): TaskMoment[] {
  const telling = moments.filter((m) => m.text);
  return (telling.length ? telling : moments).slice(0, ROW_MOMENTS);
}

/** The choices a row may offer under its title: two short ones at most, and only where a one-tap answer is safe. */
export function rowAnswers(question: DecisionView | null): string[] {
  if (!question) return [];
  const choices = rowChoices(question);
  return choices.length >= 1 && choices.length <= 2 && choices.every((c) => c.length <= 24) ? choices : [];
}

type Built = { row: TaskRow; item: WorkItem };

/**
 * Rows for every task in the tree, then the list for one scope and view.
 * - flight: tasks that need you, failed, stalled or are working, flat, by channel.
 * - all: every open task by channel, then project; a project row rolls up what is inside and carries two levels.
 * - review: finished and unreviewed tasks, grouped by project.
 */
export function buildTaskList(src: TaskSource, opts: { scope: string; view: TaskView; now?: number }): TaskListResponse {
  const now = opts.now ?? Date.now();
  const byId = new Map(src.items.map((i) => [i.id, i]));
  const kids = new Map<string, WorkItem[]>();
  for (const i of src.items) if (i.parentId && isTask(i)) kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i]);
  const runsBy = new Map<string, CoordinatorRunRow[]>();
  for (const r of src.runs) runsBy.set(r.itemId, [...(runsBy.get(r.itemId) ?? []), r]);
  const asksBy = new Map<string, Decision[]>();
  for (const d of src.decisions) if (d.state === "open") asksBy.set(d.itemId, [...(asksBy.get(d.itemId) ?? []), d]);
  const name = (profile: string | null | undefined) => (profile ? (src.name?.(profile) ?? profile) : null);

  const areaOf = (id: string): WorkItem | null => {
    let c = byId.get(id);
    for (let n = 0; c?.parentId && n < 50; n++) c = byId.get(c.parentId);
    return c && c.parentId === null ? c : null;
  };
  const pathOf = (item: WorkItem) => {
    const parts: string[] = [];
    for (let c = item.parentId ? byId.get(item.parentId) : undefined, n = 0; c && n < 8; c = c.parentId ? byId.get(c.parentId) : undefined, n++)
      parts.unshift(c.title);
    return parts.join(" › ");
  };

  const built = new Map<string, Built>();
  const rowOf = (item: WorkItem): TaskRow => {
    const cached = built.get(item.id);
    if (cached) return cached.row;
    const runs = runsBy.get(item.id) ?? [];
    const asks = [...(asksBy.get(item.id) ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const info = src.info[item.id];
    const facts: TaskRunFact[] = runs
      .filter((r) => !r.parentRunId)
      .map((r) => ({
        state: r.state,
        stalled: r.stalled,
        startedAt: r.startedAt,
        updatedAt: r.updatedAt,
        summary: tidyOutcome(r.summary),
        waitsFor: r.lock?.mode === "waits" ? r.lock.name : null,
      }));
    // A question the task carries itself (no D-n row yet) still needs the owner.
    const own = !asks.length && item.decision ? [{ question: item.decision.question, askedAt: item.decision.askedAt || item.updatedAt }] : [];
    const status = taskState({
      status: item.status,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      completedAt: item.completedAt,
      nextAction: item.nextAction,
      questions: [...asks.map((d) => ({ question: d.question, askedAt: d.createdAt })), ...own],
      approvalAt: info?.live === "waiting" && info.approval ? info.liveAt : null,
      chatRunningAt: info?.live === "running" ? info.liveAt : null,
      runs: facts,
    });
    const open = runs.filter((r) => r.state === "running" || r.state === "waiting");
    const deciding = runs.find((r) => r.state === "waiting") ?? runs.find((r) => r.state === "running" || r.state === "interrupted") ?? runs[0];
    const agentWork = status.state === "working" || status.state === "stalled" || status.state === "failed" || (status.state === "needs" && !!deciding);
    const assigned = info?.who ? (info.who.kind === "person" ? info.who.name : name(info.who.name)) : null;
    const pr = info?.prs[0];
    const children = kids.get(item.id) ?? [];
    const chat = primarySessionOf(item) ?? null;
    const row: TaskRow = {
      ...status,
      id: item.id,
      title: item.title,
      path: pathOf(item),
      areaId: areaOf(item.id)?.id ?? null,
      parentId: item.parentId,
      project: item.kind === "project" || children.length > 0,
      who: agentWork && deciding ? name(deciding.profile) : assigned,
      activity: rowMoments(
        taskMoments(
          runs,
          src.events.filter((e) => runs.some((r) => r.id === e.runId)),
          asks,
        ),
      ),
      question: asks[0] ? viewOfDecision({ ...asks[0], itemTitle: item.title }) : null,
      pr: pr ? { label: /^\d+$/.test(pr.ref) ? `PR ${pr.ref}` : pr.ref.replace(/^.*#(\d+)$/, "PR $1"), url: pr.url, state: pr.state, checks: pr.checks } : null,
      chat,
      can: {
        steer: status.state === "working" || status.state === "stalled" || (status.state === "needs" && !asks.length),
        stop: open.length > 0 || (status.state === "working" && !!chat),
        retry: status.state === "failed" || status.state === "stalled",
      },
    };
    built.set(item.id, { row, item });
    return row;
  };

  const descendants = (id: string): WorkItem[] => {
    const out: WorkItem[] = [];
    const stack = [...(kids.get(id) ?? [])];
    const seen = new Set<string>([id]);
    while (stack.length) {
      const i = stack.pop()!;
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      out.push(i);
      stack.push(...(kids.get(i.id) ?? []));
    }
    return out;
  };
  const rollupOf = (id: string): TaskRollup => {
    const r = emptyRollup();
    for (const i of descendants(id)) {
      // What is inside a project is its tasks; a nested project counts through its own tasks.
      if (i.kind === "project" || (kids.get(i.id) ?? []).length) continue;
      r.total++;
      const state = rowOf(i).state;
      if (state === "done") r.done++;
      else if (state !== "idle") r[state]++;
    }
    return r;
  };
  /** A row for the All view: a project carries its roll-up and the rows inside, `levels` deep. */
  const nested = (item: WorkItem, levels: number): TaskRow => {
    const row = rowOf(item);
    if (!row.project) return row;
    const inside = (kids.get(item.id) ?? []).filter((c) => !isClosed(c.status));
    const rollup = rollupOf(item.id);
    if (levels <= 0) return { ...row, rollup, more: inside.length };
    return { ...row, rollup, children: inside.map((c) => nested(c, levels - 1)).sort(byTaskRank) };
  };

  // Scope: everything, one channel, or what is inside one project.
  const scopeItem = opts.scope === "all" ? null : (byId.get(opts.scope) ?? null);
  const areas = src.items.filter((i) => i.parentId === null).sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
  const inScope = scopeItem ? descendants(scopeItem.id) : src.items.filter(isTask);
  const tasks = inScope.filter(isTask);
  const rows = tasks.map(rowOf);
  const open = rows.filter((r) => r.state !== "done");

  const reviewRows = open.filter((r) => r.state === "review" && !r.project);
  const projectOf = (row: TaskRow): WorkItem | null => {
    for (let c = row.parentId ? byId.get(row.parentId) : undefined, n = 0; c && n < 50; c = c.parentId ? byId.get(c.parentId) : undefined, n++)
      if (c.parentId === null || c.kind === "project") return c;
    return null;
  };
  const group = (id: string, title: string, list: TaskRow[]): TaskGroup => ({ id, title, needs: list.filter((r) => r.state === "needs").length, rows: list });

  let groups: TaskGroup[];
  if (opts.view === "review") {
    const by = new Map<string, { title: string; rows: TaskRow[] }>();
    for (const row of reviewRows) {
      const p = projectOf(row);
      const key = p?.id ?? "";
      by.set(key, { title: p?.title ?? "No project", rows: [...(by.get(key)?.rows ?? []), row] });
    }
    groups = [...by.entries()]
      .map(([id, g]) =>
        group(
          id,
          g.title,
          g.rows.sort((a, b) => (a.since ?? "").localeCompare(b.since ?? "")),
        ),
      )
      .sort((a, b) => (a.rows[0]?.since ?? "").localeCompare(b.rows[0]?.since ?? ""));
  } else if (scopeItem && scopeItem.parentId !== null) {
    // Inside a project: its own rows, sub-projects opening in place.
    const direct = (kids.get(scopeItem.id) ?? []).filter((c) => !isClosed(c.status));
    const list = opts.view === "flight" ? open.filter((r) => isInFlight(r.state)) : direct.map((c) => nested(c, PROJECT_LEVELS - 1));
    groups = list.length ? [group(scopeItem.id, scopeItem.title, list.sort(byTaskRank))] : [];
  } else {
    const channels = scopeItem ? [scopeItem] : areas;
    groups = channels
      .map((area) => {
        const list =
          opts.view === "flight"
            ? open.filter((r) => r.areaId === area.id && isInFlight(r.state))
            : (kids.get(area.id) ?? []).filter((c) => !isClosed(c.status)).map((c) => nested(c, PROJECT_LEVELS));
        return group(area.id, area.title, list.sort(byTaskRank));
      })
      .filter((g) => g.rows.length)
      // Channels with something needing you come first; the rest keep the owner's own order.
      .sort((a, b) => Number(b.needs > 0) - Number(a.needs > 0));
  }

  const since = src.lastLooked ? Date.parse(src.lastLooked) : now - 86_400_000;
  const closed = rows.filter((r) => r.state === "done" && !r.project && r.since && Date.parse(r.since) > since).sort(recent);
  const projects = new Set(reviewRows.map((r) => projectOf(r)?.id ?? ""));
  const inProject = scopeItem && scopeItem.parentId !== null;
  const project: TaskListResponse["project"] = inProject
    ? {
        rollup: rollupOf(scopeItem.id),
        atWork: open
          .filter((r) => r.state === "working" && !r.project)
          .sort(recent)
          .map((r) => ({ id: r.id, title: r.title, who: r.who, since: r.since })),
        timeline: rows
          .flatMap((r) => r.activity.map((m) => ({ ...m, taskId: r.id, task: r.title })))
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
          .slice(0, PROJECT_MOMENTS),
      }
    : undefined;
  return {
    view: opts.view,
    scope: opts.scope,
    ...(project ? { project } : {}),
    groups,
    needs: open.filter((r) => r.state === "needs").length,
    review: reviewRows.length
      ? {
          count: reviewRows.length,
          projects: projects.size,
          oldestAt: reviewRows.reduce<string | null>((m, r) => (r.since && (!m || r.since < m) ? r.since : m), null),
        }
      : null,
    done: closed.length ? { count: closed.length, titles: closed.slice(0, 2).map((r) => r.title) } : null,
    open: open.filter((r) => !r.project).length,
    fetchedAt: new Date(now).toISOString(),
  };
}
