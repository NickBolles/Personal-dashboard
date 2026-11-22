"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "@/components/icons";
import { BoardTab } from "@/components/areas/BoardTab";
import { GraphTab } from "@/components/areas/GraphTab";
import { useDecisionFlowController } from "@/components/decisions/useAnswerDecision";
import { Button, Pill, ProgressBar, Segmented, useNow } from "@/components/ui";
import { InlineAdd } from "@/components/work/QuickAdd";
import { ItemRows } from "@/components/work/Rollup";
import type { RollupItemRow } from "@/lib/item-page";
import { rollupLine } from "@/lib/task-list";
import { shortAge, shortWhen } from "@/lib/task-state";
import type { WorkItem } from "@/lib/work";
import { TaskList, TaskRowView, useTaskList } from "./TaskList";

const VIEWS = [
  { value: "list", label: "List" },
  { value: "board", label: "Board" },
  { value: "graph", label: "Graph" },
] as const;
type View = (typeof VIEWS)[number]["value"];

/**
 * What a project's Overview adds to a task's (task threads, step 3): the roll-up of what is inside, the tasks that
 * need you (answered here), its Tasks in three views switched in place, the agents working anywhere inside it and
 * a timeline across its tasks. The rows are the In flight rows, read by the same call with this project as scope.
 */
export function ProjectTasks({
  parent,
  items,
  done,
  onSelect,
  onOpenTask,
  onFull,
}: {
  parent: WorkItem;
  /** The whole tree (the graph draws the project in it). */
  items: WorkItem[];
  /** Closed tasks directly inside, folded to one row under the list. */
  done: readonly RollupItemRow[];
  onSelect: (id: string) => void;
  /** Open a task on its Overview or its Chat (this page opens tasks itself, without leaving). */
  onOpenTask: (id: string, to: "overview" | "chat") => void;
  /** Open Board or Graph as a full view of this project. */
  onFull: (view: "board" | "graph") => void;
}) {
  const now = useNow();
  const qc = useQueryClient();
  const flow = useDecisionFlowController();
  const [view, setView] = useState<View>("list");
  const [adding, setAdding] = useState(false);
  const all = useTaskList(parent.id, "all");
  const flight = useTaskList(parent.id, "flight");
  const project = all.data?.project;
  const needs = (flight.data?.groups.flatMap((g) => g.rows) ?? []).filter((r) => r.state === "needs");
  const onChanged = () => void qc.invalidateQueries({ queryKey: ["work"] });
  const pct = project && project.rollup.total ? Math.round((project.rollup.done / project.rollup.total) * 100) : 0;
  return (
    <>
      {project?.rollup.total ? (
        <section className="ip-sec" aria-label="Progress" data-testid="project-rollup">
          <ProgressBar value={pct} tone="ok" label={`${project.rollup.done} of ${project.rollup.total} tasks done`} />
          <p className="tl-quiet">{rollupLine(project.rollup)}</p>
        </section>
      ) : null}
      {needs.length ? (
        <section className="ip-sec" aria-labelledby="ip-needs-h" data-testid="project-needs">
          <h3 id="ip-needs-h" className="ip-label">
            Needs you <span className="ip-count">· {needs.length}</span>
          </h3>
          <div>
            {needs.map((row) => (
              <TaskRowView key={row.id} row={row} flow={flow} onChanged={onChanged} open={onOpenTask} />
            ))}
          </div>
        </section>
      ) : null}
      <section aria-labelledby="kids-work" className="ip-sec" data-testid="children-work">
        <h3 id="kids-work" className="ip-label">
          Tasks <span className="ip-count">· {all.data ? `${all.data.open} open` : ""}</span>
          <span className="ip-label-acts">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={<PlusIcon className="h-4 w-4" />}
              title="Add task, sub-project or path"
              onClick={() => setAdding(true)}
            >
              Add task, sub-project or path
            </Button>
          </span>
        </h3>
        <div className="tl-views">
          <Segmented label="View of the tasks" options={[...VIEWS]} value={view} onChange={setView} />
          {view === "list" ? null : (
            <Button size="sm" variant="ghost" onClick={() => onFull(view)}>
              Open full screen
            </Button>
          )}
        </div>
        {adding ? (
          <div className="ip-inline-add">
            <InlineAdd parent={parent} onDone={() => setAdding(false)} />
          </div>
        ) : null}
        {view === "list" ? (
          <>
            <TaskList
              scope={parent.id}
              view="all"
              bare
              limit={8}
              open={onOpenTask}
              exclude={needs.map((r) => r.id)}
              empty={<p className="tl-quiet">No open tasks</p>}
            />
            {done.length ? (
              <div className="ip-rows">
                <ItemRows open={[]} done={done} onSelect={onSelect} />
              </div>
            ) : null}
          </>
        ) : view === "board" ? (
          <div data-scroll-x>
            <BoardTab scopeId={parent.id} onOpen={onSelect} />
          </div>
        ) : (
          <div data-noswipe>
            <GraphTab items={items} centreId={parent.id} onRecentre={(id) => (id ? onSelect(id) : undefined)} onOpen={onSelect} />
          </div>
        )}
      </section>
      {project?.atWork.length ? (
        <section className="ip-sec" aria-labelledby="ip-atwork-h" data-testid="project-at-work">
          <h3 id="ip-atwork-h" className="ip-label">
            Agents at work <span className="ip-count">· {project.atWork.length}</span>
          </h3>
          <ul className="tl-plain">
            {project.atWork.map((w) => (
              <li key={w.id}>
                <Button size="sm" variant="ghost" className="tl-plain-link" onClick={() => onOpenTask(w.id, "overview")}>
                  {w.who ? `${w.who} · ` : ""}
                  {w.title}
                </Button>
                <span className="tl-plain-age" data-dynamic>
                  {shortAge(w.since, now)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {project?.timeline.length ? (
        <section className="ip-sec" aria-labelledby="ip-ptl-h" data-testid="project-timeline">
          <h3 id="ip-ptl-h" className="ip-label">
            Timeline
          </h3>
          <ol className="tl-plain">
            {project.timeline.map((m) => (
              <li key={`${m.taskId}:${m.id}`}>
                <Pill tone={m.tone} className="tl-chip">
                  {m.label}
                </Pill>
                <Button size="sm" variant="ghost" className="tl-plain-link" onClick={() => onOpenTask(m.taskId, "overview")}>
                  {m.text ? `${m.text} · ` : ""}
                  {m.task}
                </Button>
                <time className="tl-plain-age" dateTime={m.at} data-dynamic>
                  {shortWhen(m.at, now)}
                </time>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </>
  );
}
