"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ChevronIcon, LogIcon } from "@/components/icons";
import { RowAction, StateWord, ThingRow } from "@/components/ui";
import { useTagDirectory } from "@/components/work/ItemMeta";
import { coordHref, type ContainerRollup, type RollupItemRow } from "@/lib/item-page";
import { assigneeLabel } from "@/lib/item-tags";
import { WORK_GROUP_LABEL, WORK_WORD } from "@/lib/work-words";

const dot = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" · ");

/**
 * Needs you and Working on a project or area page, rolled up from everything under it. A decision opens in the
 * Chief of staff panel; a run opens the item it is on, and its Log icon opens the run's report and timeline.
 * Neither group is drawn when it is empty.
 */
export function RollupGroups({ id, rollup, onSelect }: { id: string; rollup: Pick<ContainerRollup, "needs" | "working">; onSelect: (id: string) => void }) {
  const router = useRouter();
  const run = (row: ContainerRollup["working"][number]) => (
    <ThingRow
      key={row.key}
      className="ip-row"
      data-testid="rollup-run"
      state={row.state}
      refId={row.refId}
      title={row.title}
      sub={
        <>
          <StateWord state={row.state} />
          {row.note ? ` · ${row.note}` : ""}
          {row.itemTitle ? ` · ${row.itemTitle}` : ""}
        </>
      }
      onOpen={() => onSelect(row.itemId)}
      actions={
        <RowAction label={`Log of ${row.refId}`} icon={<LogIcon className="h-4 w-4" />} onClick={() => router.push(coordHref(id, "running", row.refId))} />
      }
    />
  );
  return (
    <>
      {rollup.needs.length ? (
        <section className="ip-sec" aria-labelledby="ip-needs-h" data-testid="rollup-needs">
          <h3 id="ip-needs-h" className="ip-label">
            {WORK_GROUP_LABEL.needs} <span className="ip-count">· {rollup.needs.length}</span>
          </h3>
          <div className="ip-rows">
            {rollup.needs.map((row) =>
              row.kind === "decision" ? (
                <ThingRow
                  key={row.key}
                  className="ip-row"
                  data-testid="rollup-decision"
                  state="needs"
                  refId={row.refId}
                  title={row.title}
                  // A decision often asks about the item by name: the item is only named when it adds something.
                  sub={
                    <span data-dynamic>
                      {dot(["Decision", row.itemTitle.trim().toLowerCase() === row.title.trim().toLowerCase() ? "" : row.itemTitle, row.age])}
                    </span>
                  }
                  href={coordHref(id, "needs", row.refId)}
                  actions={<ChevronIcon className="ip-chev h-4 w-4" />}
                />
              ) : (
                run(row)
              ),
            )}
          </div>
        </section>
      ) : null}
      {rollup.working.length ? (
        <section className="ip-sec" aria-labelledby="ip-working-h" data-testid="rollup-working">
          <h3 id="ip-working-h" className="ip-label">
            {WORK_GROUP_LABEL.working} <span className="ip-count">· {rollup.working.length}</span>
          </h3>
          <div className="ip-rows">{rollup.working.map(run)}</div>
        </section>
      ) : null}
    </>
  );
}

/** One open or closed item under a project (or a sub-item under an item): its title, then its one headline. */
function ItemRow({ row, people, onSelect }: { row: RollupItemRow; people: readonly { id: string; name: string }[]; onSelect: (id: string) => void }) {
  const { item } = row;
  const done = row.state === "done";
  const who = assigneeLabel(item.assignee, people);
  const tags = (item.tags ?? []).slice(0, 2);
  const rest = dot([
    row.refs.join(" "),
    row.progress,
    row.state === "idle" || done ? row.status : "",
    row.next ? `Next · ${row.next}` : "",
    row.due.replace(/^Due /, "due "),
  ]);
  // Who has it and its tags stay addressable on the row (the list filters by both).
  const marks = (
    <>
      {who ? (
        <span data-assignee={item.assignee ?? undefined}>
          {rest ? " · " : ""}
          {who}
        </span>
      ) : null}
      {tags.map((t, index) => (
        <span key={t} data-tag={t}>
          {rest || who || index ? " · " : ""}#{t}
        </span>
      ))}
    </>
  );
  const more = !!who || tags.length > 0;
  return (
    <ThingRow
      className="ip-row"
      data-node-row={item.id}
      state={row.state}
      tight={done}
      title={item.title}
      sub={
        done ? (
          row.status
        ) : (
          <>
            {row.state === "idle" ? null : <StateWord state={row.state} />}
            {row.state !== "idle" && (rest || more) ? " · " : ""}
            {rest}
            {marks}
          </>
        )
      }
      onOpen={() => onSelect(item.id)}
      actions={<ChevronIcon className="ip-chev h-4 w-4" />}
    />
  );
}

/** Open items as rows, then "Done · N" as one tight row that expands. */
export function ItemRows({ open, done, onSelect }: { open: readonly RollupItemRow[]; done: readonly RollupItemRow[]; onSelect: (id: string) => void }) {
  const [showDone, setShowDone] = useState(false);
  // People's names for the assignee on a row (agents are named by their profile and need no lookup).
  const people = useTagDirectory([...open, ...done].some((row) => row.item.assignee?.startsWith("person:"))).data?.assignees.people ?? [];
  return (
    <>
      {open.map((row) => (
        <ItemRow key={row.key} row={row} people={people} onSelect={onSelect} />
      ))}
      {done.length ? (
        <ThingRow
          className="ip-row"
          state="done"
          tight
          title={WORK_WORD.done}
          sub={`${done.length} item${done.length === 1 ? "" : "s"}`}
          onOpen={() => setShowDone((s) => !s)}
          hitProps={{ "aria-expanded": showDone }}
          actions={<ChevronIcon className={`ip-chev h-4 w-4 ${showDone ? "rotate-90" : ""}`} />}
          data-testid="items-done"
        />
      ) : null}
      {showDone ? done.map((row) => <ItemRow key={row.key} row={row} people={people} onSelect={onSelect} />) : null}
    </>
  );
}
