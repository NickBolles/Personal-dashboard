"use client";

import { useId, useMemo, useState } from "react";
import { Button, Dialog, inputCls } from "@/components/ui";
import { KIND_LABELS, type WorkItem } from "@/lib/work";

export type Destination = { id: string; title: string; path: string; kind: WorkItem["kind"] };

/** Every place something can go: not archived, not a note, not a conversation, not inside `exclude`. */
export function destinations(items: WorkItem[], exclude: Set<string> = new Set()): Destination[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const blocked = new Set(exclude);
  // Exclude whole subtrees (you can't move something inside itself).
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of items)
      if (i.parentId && blocked.has(i.parentId) && !blocked.has(i.id)) {
        blocked.add(i.id);
        grew = true;
      }
  }
  return items
    .filter((i) => !i.archived && i.kind !== "note" && i.kind !== "conversation" && !blocked.has(i.id))
    .map((i) => {
      const parts: string[] = [];
      for (let p = i.parentId ? byId.get(i.parentId) : undefined; p && parts.length < 8; p = p.parentId ? byId.get(p.parentId) : undefined)
        parts.unshift(p.title);
      return { id: i.id, title: i.title, path: parts.join(" › "), kind: i.kind };
    })
    .sort((a, b) => `${a.path} ${a.title}`.localeCompare(`${b.path} ${b.title}`));
}

/**
 * Searchable destination picker (combobox + listbox) for Move to… and File to…:
 * type to filter by title or path, ↑/↓ to choose, Enter to pick. Suggested
 * destinations are listed first.
 */
export function DestinationPicker({
  title,
  description,
  items,
  exclude,
  suggested = [],
  busy,
  onPick,
  onClose,
  allowTop,
  extra,
}: {
  title: string;
  description?: string;
  items: WorkItem[];
  exclude?: Set<string>;
  suggested?: { id: string; why?: string }[];
  busy?: boolean;
  onPick: (id: string | null) => void;
  onClose: () => void;
  /** offer "Top level (as an area)" */
  allowTop?: boolean;
  extra?: React.ReactNode;
}) {
  const all = useMemo(() => destinations(items, exclude), [items, exclude]);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const lid = useId();
  const needle = q.trim().toLowerCase();
  const sugg = suggested
    .map((s) => ({ ...s, d: all.find((d) => d.id === s.id) }))
    .filter((s) => s.d && (!needle || `${s.d.path} ${s.d.title}`.toLowerCase().includes(needle)));
  const rest = all.filter((d) => !sugg.some((s) => s.id === d.id) && (!needle || `${d.path} ${d.title}`.toLowerCase().includes(needle)));
  const options: { id: string | null; label: string; path: string; why?: string; kind?: WorkItem["kind"] }[] = [
    ...(allowTop && (!needle || "top level".includes(needle)) ? [{ id: null, label: "Top level (as an area)", path: "" }] : []),
    ...sugg.map((s) => ({ id: s.id, label: s.d!.title, path: s.d!.path, why: s.why, kind: s.d!.kind })),
    ...rest.map((d) => ({ id: d.id, label: d.title, path: d.path, kind: d.kind })),
  ];
  const cur = Math.min(active, Math.max(0, options.length - 1));
  const optId = (n: number) => `${lid}-o${n}`;
  const pick = (n: number) => {
    const o = options[n];
    if (o && !busy) onPick(o.id);
  };
  return (
    <Dialog open onClose={onClose} title={title} description={description} footer={<Button onClick={onClose}>Cancel</Button>}>
      <div className="space-y-2">
        <input
          type="search"
          role="combobox"
          aria-label="Search destinations"
          aria-expanded="true"
          aria-controls={lid}
          aria-activedescendant={options.length ? optId(cur) : undefined}
          aria-autocomplete="list"
          data-autofocus
          autoComplete="off"
          className={inputCls}
          placeholder="Search areas and projects…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setActive(Math.min(cur + 1, options.length - 1));
            else if (e.key === "ArrowUp") setActive(Math.max(cur - 1, 0));
            else if (e.key === "Enter") pick(cur);
            else return;
            e.preventDefault();
            document
              .getElementById(optId(e.key === "ArrowDown" ? Math.min(cur + 1, options.length - 1) : Math.max(cur - 1, 0)))
              ?.scrollIntoView({ block: "nearest" });
          }}
        />
        {extra}
        <ul id={lid} role="listbox" aria-label="Destinations" className="wk-pick-list max-h-[50dvh] overflow-y-auto rounded-lg border border-line">
          {options.map((o, n) => (
            <li
              key={o.id ?? "top"}
              id={optId(n)}
              role="option"
              aria-selected={n === cur}
              data-dest={o.id ?? "top"}
              onMouseEnter={() => setActive(n)}
              onClick={() => pick(n)}
              onKeyDown={(e) => {
                if (e.key === "Enter") pick(n);
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{o.label}</span>
                {o.path || o.why ? (
                  <span className="block truncate text-xs text-muted">
                    {o.why ? `Suggested${o.why ? ` · ${o.why}` : ""}${o.path ? " · " : ""}` : ""}
                    {o.path}
                  </span>
                ) : null}
              </span>
              {o.kind ? <span className="text-[11px] text-muted">{o.kind === "thread" ? "Item" : KIND_LABELS[o.kind]}</span> : null}
            </li>
          ))}
        </ul>
        {!options.length ? <p className="p-1 text-sm text-muted">Nothing matches.</p> : null}
      </div>
    </Dialog>
  );
}
