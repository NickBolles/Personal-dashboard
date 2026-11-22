"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RetryIcon, SteerIcon, StopIcon } from "@/components/icons";
import { useAccess } from "@/components/access";
import { useDecisionFlowController, type DecisionFlow } from "@/components/decisions/useAnswerDecision";
import {
  Button,
  ButtonLink,
  EmptyState,
  ErrorNote,
  KSpinner,
  Pill,
  RefPill,
  RowAction,
  SectionHeader,
  StateWord,
  ThingRow,
  useNow,
  useToast,
} from "@/components/ui";
import { api } from "@/lib/client/api";
import { rollupLine, rowAnswers, type TaskListResponse, type TaskMoment, type TaskRow, type TaskView } from "@/lib/task-list";
import { TASK_MARK, TASK_WORD, shortAge, shortWhen, taskDetail, type TaskState } from "@/lib/task-state";
import "./task-list.css";

/**
 * The task list (task threads, step 3): one component and one read for In flight, every bot's Tasks tab, a
 * project's Tasks section and the review queue. Only `scope` and `view` differ.
 *
 * A row is three lines: its state with age and who has it; its title; then the latest activity fading into the one
 * before. The title opens the task on Overview; the activity line opens the timeline in place. Icon actions are in
 * a fixed order: Steer, then Stop or Retry. Only "Working" moves.
 */

export const taskListKey = (scope: string, view: TaskView) => ["work", "tasks", scope, view] as const;

/** Lists refresh on a timer; only an open chat holds a live connection. */
export function useTaskList(scope: string, view: TaskView, enabled = true) {
  return useQuery({
    queryKey: taskListKey(scope, view),
    queryFn: ({ signal }) => api.get<TaskListResponse>(`/api/work/tasks?scope=${encodeURIComponent(scope)}&view=${view}`, signal),
    enabled,
    refetchInterval: 15_000,
  });
}

export const taskHref = (id: string, to: "overview" | "chat" | "question" | "steer" | "retry" | "resume" = "overview") => {
  const base = `/areas?item=${encodeURIComponent(id)}`;
  if (to === "chat") return `${base}&tab=chat`;
  if (to === "steer") return `${base}&tab=chat&compose=1`;
  if (to === "retry" || to === "resume") return `${base}&tab=chat&draft=${to}`;
  if (to === "question") return `${base}#ip-next-h`;
  return base;
};

const ic = "h-4 w-4";

/** The state in its word and colour. "Working" shimmers the way it does in a chat; nothing else in a list moves. */
export function TaskStateWord({ state }: { state: TaskState }) {
  if (state === "review" || state === "idle")
    return (
      <span className="k-sw tl-word" data-task-state={state}>
        {TASK_WORD[state]}
      </span>
    );
  return (
    <StateWord state={TASK_MARK[state] === "idle" ? "done" : (TASK_MARK[state] as Exclude<(typeof TASK_MARK)[TaskState], "idle">)} live={state === "working"}>
      {TASK_WORD[state]}
    </StateWord>
  );
}

function MomentLine({ moment, now }: { moment: TaskMoment; now: number }) {
  return (
    <span className="tl-moment">
      <Pill tone={moment.tone} className="tl-chip">
        {moment.label}
      </Pill>
      <span className="tl-moment-text">{moment.text}</span>
      <time dateTime={moment.at} data-dynamic>
        {shortWhen(moment.at, now)}
      </time>
    </span>
  );
}

/** A task's whole timeline, newest first, each line with its type and time. Read when a row is opened. */
export function TaskTimeline({ taskId, title, seed, onOpen }: { taskId: string; title: string; seed: TaskMoment[]; onOpen?: () => void }) {
  const now = useNow();
  const q = useQuery({
    queryKey: ["work", "tasks", "timeline", taskId],
    queryFn: ({ signal }) => api.get<{ moments: TaskMoment[] }>(`/api/work/items/${encodeURIComponent(taskId)}/timeline`, signal),
    refetchInterval: 15_000,
  });
  const moments = q.data?.moments ?? seed;
  return (
    <div className="tl-timeline">
      {moments.length ? (
        <ol aria-label={`Timeline for ${title}`}>
          {moments.map((m) => (
            <li key={m.id}>
              <MomentLine moment={m} now={now} />
            </li>
          ))}
        </ol>
      ) : (
        <p className="tl-quiet">{q.isLoading ? "Loading…" : "Nothing has happened yet"}</p>
      )}
      {q.error && !q.data ? <p className="tl-quiet">Couldn&apos;t load the rest</p> : null}
      {onOpen ? (
        <Button size="sm" variant="ghost" className="tl-open" onClick={onOpen}>
          Open task
        </Button>
      ) : (
        <ButtonLink href={taskHref(taskId)} size="sm" variant="ghost" className="tl-open">
          Open task
        </ButtonLink>
      )}
    </div>
  );
}

type RowHooks = {
  flow: DecisionFlow;
  /** Split view: picking a row shows its thread beside the list instead of leaving it. */
  onPick?: (row: TaskRow, to: "overview" | "chat") => void;
  /** The list sits on a page that opens tasks itself (the areas page): every way into a task goes through this. */
  open?: (id: string, to: "overview" | "chat") => void;
  selectedId?: string | null;
  /** The review queue: rows can be ticked. */
  select?: { ids: readonly string[]; toggle: (id: string) => void };
  onChanged: () => void;
};

export function TaskRowView({ row, depth = 0, ...hooks }: { row: TaskRow; depth?: number } & RowHooks) {
  const now = useNow();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const stop = useMutation({
    mutationFn: () => api.post(`/api/work/items/${encodeURIComponent(row.id)}/stop`),
    onSuccess: () => {
      setConfirmStop(false);
      toast("Stopped");
      hooks.onChanged();
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't stop it. Try again.", "danger"),
  });
  const go = (to: Parameters<typeof taskHref>[1]) => {
    const chat = to !== "overview" && to !== "question";
    if (hooks.open) hooks.open(row.id, chat ? "chat" : "overview");
    else if (hooks.onPick && (to === "steer" || to === "chat")) hooks.onPick(row, "chat");
    else router.push(taskHref(row.id, to));
  };
  const answers = rowAnswers(row.question);
  const receipt = row.question ? hooks.flow.receipts[row.question.ref] : undefined;
  const sending = !!row.question && hooks.flow.pending.includes(row.question.ref);
  const detail = row.project && row.rollup ? [rollupLine(row.rollup)] : taskDetail(row, null, now);
  // Who has it: always while an agent is on it; on work nothing has touched, only its own assignee.
  const who = row.project || row.state === "done" || (row.state === "idle" && !row.assignee) ? null : row.who;
  const tags = row.project ? [] : row.tags.slice(0, 2);
  const inside = row.children ?? [];
  const opens = row.project ? inside.length > 0 || !!row.more : true;
  const lines = row.activity.slice(0, 2);
  const peek = row.project ? null : lines.length ? (
    <>
      {lines.map((m) => (
        <span key={m.id}>
          <MomentLine moment={m} now={now} />
        </span>
      ))}
    </>
  ) : row.line ? (
    <span>{row.line}</span>
  ) : null;
  const ticked = hooks.select?.ids.includes(row.id);
  return (
    <div
      className="tl-row"
      data-testid="task-row"
      data-task={row.id}
      data-task-state={row.state}
      data-node-row={row.id}
      data-selected={hooks.selectedId === row.id || undefined}
      data-depth={depth || undefined}
    >
      <ThingRow
        state={row.project ? "idle" : TASK_MARK[row.state]}
        title={row.title}
        status={
          <>
            {row.project ? <span className="tl-kind">Project</span> : <TaskStateWord state={row.state} />}
            {detail.map((part) => (
              <span key={part} className="tl-detail" data-dynamic>
                {" "}
                · {part}
              </span>
            ))}
            {who ? (
              <span className="tl-detail" data-assignee={row.assignee ?? undefined}>
                {" "}
                · {who}
              </span>
            ) : null}
            {tags.map((tag) => (
              <span key={tag} className="tl-detail" data-tag={tag}>
                {" "}
                · #{tag}
              </span>
            ))}
          </>
        }
        {...(hooks.open
          ? { onOpen: () => hooks.open!(row.id, "overview") }
          : hooks.onPick
            ? { onOpen: () => hooks.onPick!(row, "overview") }
            : { href: taskHref(row.id) })}
        peek={peek ?? undefined}
        sub={
          row.state === "needs" && !receipt ? (
            <span className="tl-ask">
              {row.question ? <RefPill id={row.question.ref} /> : null}
              {answers.length ? (
                answers.map((choice) => (
                  <Button key={choice} size="sm" disabled={sending} onClick={() => void hooks.flow.answer(row.question!, choice).then(() => hooks.onChanged())}>
                    {choice}
                  </Button>
                ))
              ) : hooks.open ? (
                <Button size="sm" onClick={() => go(row.question ? "question" : "chat")}>
                  Answer
                </Button>
              ) : (
                <ButtonLink size="sm" href={taskHref(row.id, row.question ? "question" : "chat")}>
                  Answer
                </ButtonLink>
              )}
            </span>
          ) : receipt ? (
            <span className="tl-ask" role="status">
              <span className="tl-receipt">Answered: {receipt.choice}</span>
              {receipt.undoable ? (
                <Button size="sm" variant="ghost" onClick={() => void hooks.flow.undo(receipt.view.ref).then(() => hooks.onChanged())}>
                  Undo
                </Button>
              ) : null}
            </span>
          ) : row.pr ? (
            <span className="tl-pr">
              {row.pr.label}
              {row.pr.state ? ` · ${row.pr.state}` : ""}
              {row.pr.checks === "failure" ? " · checks failing" : row.pr.checks === "pending" ? " · checks running" : ""}
            </span>
          ) : undefined
        }
        expanded={opens ? open : undefined}
        onToggle={opens ? () => setOpen((v) => !v) : undefined}
        toggleLabel={row.project ? `Tasks in ${row.title}` : `Timeline for ${row.title}`}
        actions={
          hooks.select ? (
            <Button
              size="sm"
              variant="ghost"
              className="tl-tick"
              aria-pressed={!!ticked}
              aria-label={`${ticked ? "Selected" : "Select"} ${row.title}`}
              onClick={() => hooks.select!.toggle(row.id)}
            >
              {ticked ? "Selected" : "Select"}
            </Button>
          ) : row.project ? undefined : row.state === "review" ? (
            <Button size="sm" variant="ghost" aria-label={`Send back ${row.title}`} onClick={() => go("steer")}>
              Send back
            </Button>
          ) : (
            <>
              {row.can.steer ? <RowAction label={`Steer ${row.title}`} icon={<SteerIcon className={ic} />} onClick={() => go("steer")} /> : null}
              {row.can.stop ? (
                <RowAction
                  label={`Stop ${row.title}`}
                  tone="danger"
                  icon={<StopIcon className={ic} />}
                  aria-expanded={confirmStop}
                  onClick={() => setConfirmStop((v) => !v)}
                />
              ) : row.can.retry ? (
                <RowAction
                  label={`${row.state === "failed" ? "Retry" : "Resume"} ${row.title}`}
                  icon={<RetryIcon className={ic} />}
                  onClick={() => go(row.state === "failed" ? "retry" : "resume")}
                />
              ) : null}
            </>
          )
        }
      >
        {row.project ? (
          <div className="tl-inside">
            {inside.map((child) => (
              <TaskRowView key={child.id} row={child} depth={depth + 1} {...hooks} />
            ))}
            {row.more ? (
              hooks.open ? (
                <Button size="sm" variant="ghost" className="tl-open" onClick={() => go("overview")}>
                  Open project · {row.more} inside
                </Button>
              ) : (
                <ButtonLink href={taskHref(row.id)} size="sm" variant="ghost" className="tl-open">
                  Open project · {row.more} inside
                </ButtonLink>
              )
            ) : null}
          </div>
        ) : (
          <TaskTimeline taskId={row.id} title={row.title} seed={row.activity} onOpen={hooks.open ? () => go("overview") : undefined} />
        )}
      </ThingRow>
      {confirmStop ? (
        <div role="group" aria-label={`Stop work on ${row.title}?`} className="tl-confirm">
          <p>Stop work on this task? You can resume it after.</p>
          <Button size="sm" variant="danger" loading={stop.isPending} onClick={() => stop.mutate()}>
            Stop
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** "9 days": the oldest thing in a queue, in words. */
const oldest = (at: string | null, now: number) => {
  const age = shortAge(at, now);
  if (!age || age === "now") return "";
  const n = parseInt(age, 10);
  const unit = age.endsWith("d") ? "day" : age.endsWith("h") ? "hour" : "minute";
  return `oldest ${n} ${unit}${n === 1 ? "" : "s"}`;
};

export type TaskListProps = {
  scope: string;
  view: TaskView;
  /** Where the review row leads (the review page for this scope). */
  reviewHref?: string;
  /** Leave the channel heading out (a project's own list). */
  bare?: boolean;
  /** Shown before the groups: the surface's own first rows. */
  lead?: ReactNode;
  empty?: ReactNode;
  onPick?: RowHooks["onPick"];
  open?: RowHooks["open"];
  selectedId?: string | null;
  select?: RowHooks["select"];
  /** Rows shown per group before "Show more". */
  limit?: number;
  /** Top-level rows this surface already draws elsewhere (a thing is drawn once per screen). */
  exclude?: readonly string[];
};

export function TaskList({ scope, view, reviewHref, bare, lead, empty, onPick, open, selectedId, select, limit, exclude }: TaskListProps) {
  const q = useTaskList(scope, view);
  const qc = useQueryClient();
  const flow = useDecisionFlowController();
  const now = useNow();
  const [all, setAll] = useState<string[]>([]);
  const onChanged = () => void qc.invalidateQueries({ queryKey: ["work"] });
  const groups = (q.data?.groups ?? [])
    .map((g) => (exclude?.length ? { ...g, rows: g.rows.filter((r) => !exclude.includes(r.id)) } : g))
    .filter((g) => g.rows.length);
  const data = q.data;
  const hooks: RowHooks = { flow, onPick, open, selectedId, select, onChanged };
  return (
    <div className="tl" data-testid="task-list" data-view={view} data-stale={q.error && data ? "" : undefined}>
      {q.error && !data ? <ErrorNote error={q.error} retry={() => void q.refetch()} /> : null}
      {!data && !q.error ? <KSpinner label="Loading tasks…" /> : null}
      {lead}
      {groups.map((group) => {
        const shown = limit && !all.includes(group.id) ? group.rows.slice(0, limit) : group.rows;
        return (
          <section key={group.id} aria-label={group.title} className="tl-group" data-testid="task-group">
            {bare ? null : <SectionHeader label={group.title} count={group.rows.length} />}
            {shown.map((row) => (
              <TaskRowView key={row.id} row={row} {...hooks} />
            ))}
            {shown.length < group.rows.length ? (
              <Button size="sm" variant="ghost" className="tl-open" onClick={() => setAll((ids) => [...ids, group.id])}>
                Show {group.rows.length - shown.length} more
              </Button>
            ) : null}
          </section>
        );
      })}
      {data && view === "flight" && (data.review || data.done) ? (
        <section aria-label="Finished" className="tl-group">
          {bare ? null : <SectionHeader label="Finished" />}
          {data.review ? (
            <ThingRow
              state="done"
              data-testid="review-row"
              title={`Ready for review · ${data.review.count}`}
              sub={
                <span data-dynamic>
                  {[data.review.projects === 1 ? "In 1 project" : `Across ${data.review.projects} projects`, oldest(data.review.oldestAt, now)]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              }
              href={reviewHref ?? "/resume/review"}
            />
          ) : null}
          {data.done ? (
            <ThingRow
              state="done"
              data-testid="done-row"
              title={`Done since you looked · ${data.done.count}`}
              sub={`${data.done.titles.join(" · ")}${data.done.count > data.done.titles.length ? ` · ${data.done.count - data.done.titles.length} more` : ""}`}
            />
          ) : null}
        </section>
      ) : null}
      {data && !groups.length && !(view === "flight" && (data.review || data.done)) ? (empty ?? <EmptyState title="Nothing here" />) : null}
    </div>
  );
}

/** May this person talk to an agent (so a new task can start its chat)? */
export function useCanChat() {
  const { capabilities } = useAccess();
  return capabilities.includes("hermes.chat");
}
