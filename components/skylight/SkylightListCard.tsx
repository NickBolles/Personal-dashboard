"use client";

import { useId, useState } from "react";
import type { NextAction } from "@/lib/contracts";
import type { SkylightWriteOp } from "@/lib/skylight-write";
import { Button, cx, inputCls, useOnline } from "@/components/ui";
import { listWrite, type SkylightList } from "./model";

export function SkylightListCard({
  list,
  items,
  writable,
  request,
}: {
  list: SkylightList;
  items: NextAction[];
  writable: boolean;
  request: (op: SkylightWriteOp) => void;
}) {
  const id = useId();
  const online = useOnline();
  const [label, setLabel] = useState("");
  const [expanded, setExpanded] = useState(false);
  const pending = items.filter((item) => item.status !== "completed");
  const completed = items.filter((item) => item.status === "completed");
  const visible = [...pending, ...(expanded ? completed : completed.slice(0, 5))];
  return (
    <article className="card min-w-0 p-3" aria-labelledby={id}>
      <h3 id={id} className="mb-1 text-sm font-semibold">
        {list.label}
      </h3>
      {visible.length ? (
        <ul className="divide-y divide-line">
          {visible.map((item) => {
            const op = listWrite(item);
            return (
              <li key={item.id} className={cx("text-sm", item.status === "completed" && "text-muted")}>
                <label className="flex min-h-11 cursor-pointer items-center gap-2 py-1 sm:min-h-9 dense:min-h-[30px]">
                  <input
                    type="checkbox"
                    className="h-4 w-4 shrink-0 accent-accent"
                    aria-label={item.title}
                    checked={item.status === "completed"}
                    disabled={!writable || !online || !op}
                    onChange={() => {
                      if (op) request(op);
                    }}
                  />
                  <span className="min-w-0 break-words">{item.title}</span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="py-2 text-sm text-muted">No items yet.</p>
      )}
      {completed.length > 5 ? (
        <Button type="button" size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer" : `Show ${completed.length - 5} more`}
        </Button>
      ) : null}
      {writable ? (
        <form
          className="mt-2 flex min-w-0 flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!label.trim() || !online) return;
            request({ op: "list.add", listId: list.id, listLabel: list.label, label: label.trim() });
            setLabel("");
          }}
        >
          <input
            aria-label={`Add to ${list.label}`}
            className={`${inputCls} min-w-0 flex-1 basis-32`}
            placeholder="Add an item…"
            maxLength={500}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!label.trim() || !online}>
            Add
          </Button>
        </form>
      ) : null}
    </article>
  );
}
