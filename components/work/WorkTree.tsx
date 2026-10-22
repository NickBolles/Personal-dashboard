"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cx, inputCls } from "@/components/ui";
import { STATUS_LABELS, type WorkItem } from "@/lib/work";
import { StatusDot } from "./common";

/**
 * Nested work tree (WAI-ARIA tree pattern): one tab stop, arrows move,
 * Right/Left expand/collapse (or go to parent), Enter/Space selects.
 * Rows hold no buttons so treeitems never nest interactive content.
 */
export function WorkTree({ items, selected, onSelect }: { items: WorkItem[]; selected: string | null; onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(selected);
  const refs = useRef(new Map<string, HTMLLIElement>());

  const { kids, byId } = useMemo(() => {
    const kids = new Map<string | null, WorkItem[]>();
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const i of items) {
      const p = i.parentId && byId.has(i.parentId) ? i.parentId : null;
      kids.set(p, [...(kids.get(p) ?? []), i]);
    }
    return { kids, byId };
  }, [items]);

  // Filtering keeps matches plus their ancestors, all expanded.
  const visibleSet = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return null;
    const keep = new Set<string>();
    for (const i of items) {
      if (`${i.title} ${i.summary} ${i.nextAction}`.toLowerCase().includes(q)) {
        for (let c: WorkItem | undefined = i; c && !keep.has(c.id); c = c.parentId ? byId.get(c.parentId) : undefined) keep.add(c.id);
      }
    }
    return keep;
  }, [filter, items, byId]);

  // When the selection changes (tree click, search link, timeline row), reveal it:
  // expand its ancestors and move the tab stop there. Adjusting state while
  // rendering is React's pattern for "reset when a prop changes".
  const [shown, setShown] = useState<string | null>(null);
  if (selected && selected !== shown && byId.has(selected)) {
    setShown(selected);
    const next = new Set(collapsed);
    for (let p = byId.get(selected)?.parentId; p; p = byId.get(p)?.parentId) next.delete(p);
    setCollapsed(next);
    setFocusId(selected);
  }

  const isOpen = (id: string) => !!visibleSet || !collapsed.has(id);
  const order: WorkItem[] = [];
  const walk = (parent: string | null) => {
    for (const i of kids.get(parent) ?? []) {
      if (visibleSet && !visibleSet.has(i.id)) continue;
      order.push(i);
      if (isOpen(i.id)) walk(i.id);
    }
  };
  walk(null);
  const tabStop = order.some((o) => o.id === focusId) ? focusId : (order[0]?.id ?? null);

  function focus(id: string | undefined) {
    if (!id) return;
    setFocusId(id);
    refs.current.get(id)?.focus();
  }
  function toggle(id: string, open?: boolean) {
    setCollapsed((c) => {
      const n = new Set(c);
      if (open ?? n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function onKey(e: KeyboardEvent, item: WorkItem) {
    const i = order.findIndex((o) => o.id === item.id);
    const hasKids = !!kids.get(item.id)?.length;
    switch (e.key) {
      case "ArrowDown":
        focus(order[i + 1]?.id);
        break;
      case "ArrowUp":
        focus(order[i - 1]?.id);
        break;
      case "Home":
        focus(order[0]?.id);
        break;
      case "End":
        focus(order.at(-1)?.id);
        break;
      case "ArrowRight":
        if (hasKids && !isOpen(item.id)) toggle(item.id, true);
        else if (hasKids) focus(kids.get(item.id)?.find((k) => !visibleSet || visibleSet.has(k.id))?.id);
        break;
      case "ArrowLeft":
        if (hasKids && isOpen(item.id) && !visibleSet) toggle(item.id, false);
        else focus(item.parentId ?? undefined);
        break;
      case "Enter":
      case " ":
        onSelect(item.id);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  const render = (parent: string | null, level: number) => {
    const list = (kids.get(parent) ?? []).filter((i) => !visibleSet || visibleSet.has(i.id));
    return list.map((i) => {
      const hasKids = !!kids.get(i.id)?.some((k) => !visibleSet || visibleSet.has(k.id));
      const open = isOpen(i.id);
      return (
        <li
          key={i.id}
          id={`wt-${i.id}`}
          ref={(el) => {
            if (el) refs.current.set(i.id, el);
            else refs.current.delete(i.id);
          }}
          role="treeitem"
          aria-level={level}
          aria-selected={selected === i.id}
          aria-expanded={hasKids ? open : undefined}
          aria-label={`${i.title}, ${STATUS_LABELS[i.status]}${i.archived ? ", archived" : ""}`}
          tabIndex={tabStop === i.id ? 0 : -1}
          onKeyDown={(e) => onKey(e, i)}
          onFocus={(e) => {
            if (e.target === e.currentTarget) setFocusId(i.id);
          }}
          onClick={(e) => {
            e.stopPropagation();
            setFocusId(i.id);
            onSelect(i.id);
          }}
          className="outline-none [&:focus-visible>div]:ring-2 [&:focus-visible>div]:ring-[var(--focus)]"
        >
          <div
            className={cx(
              "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg pr-2 text-sm",
              selected === i.id ? "bg-accent-soft text-accent font-medium" : "hover:bg-surface-2",
              i.archived && "opacity-60",
            )}
            style={{ paddingLeft: `${(level - 1) * 14 + 4}px` }}
          >
            <span
              aria-hidden="true"
              className={cx("inline-flex h-7 w-6 shrink-0 items-center justify-center text-muted", !hasKids && "invisible")}
              onClick={(e) => {
                e.stopPropagation();
                toggle(i.id);
              }}
            >
              <svg viewBox="0 0 24 24" className={cx("h-4 w-4 transition-transform", open && "rotate-90")} fill="none" stroke="currentColor" strokeWidth="2">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </span>
            <StatusDot status={i.status} />
            <span className="min-w-0 flex-1 truncate">{i.title}</span>
          </div>
          {hasKids && open ? <ul role="group">{render(i.id, level + 1)}</ul> : null}
        </li>
      );
    });
  };

  return (
    <div className="space-y-2">
      <label htmlFor="work-tree-filter" className="sr-only">
        Filter work
      </label>
      <input id="work-tree-filter" type="search" className={inputCls} placeholder="Filter work…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {order.length ? (
        <ul role="tree" aria-label="Work items" className="space-y-0.5">
          {render(null, 1)}
        </ul>
      ) : (
        <p className="p-2 text-sm text-muted">{filter ? "Nothing matches." : "No work yet."}</p>
      )}
    </div>
  );
}
