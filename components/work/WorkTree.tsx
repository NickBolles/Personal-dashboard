"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cx, inputCls } from "@/components/ui";
import { STATUS_LABELS, type WorkItem } from "@/lib/work";
import { StatusDot } from "./common";

type DropPos = "before" | "after" | "inside";
type Drag = { id: string; x: number; y: number; active: boolean; target: { id: string; pos: DropPos } | null };

/**
 * Nested work tree (WAI-ARIA tree pattern): one tab stop, arrows move,
 * Right/Left expand/collapse (or go to parent), Enter/Space selects.
 * Rows hold no buttons so treeitems never nest interactive content.
 *
 * Drag-and-drop (pointer events, mouse/pen/touch) uses the grip on each row:
 * drop on the top or bottom quarter of a row to place before/after it, or the
 * middle to put it inside. Escape cancels. The keyboard equivalents are the
 * item's "Move up", "Move down" and "Move…" actions.
 */
export function WorkTree({
  items,
  selected,
  onSelect,
  onPlace,
}: {
  items: WorkItem[];
  selected: string | null;
  onSelect: (id: string) => void;
  onPlace?: (id: string, parentId: string | null, index: number) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
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

  // --- drag and drop ---
  const subtreeOf = (id: string) => {
    const out = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const i of items)
        if (i.parentId && out.has(i.parentId) && !out.has(i.id)) {
          out.add(i.id);
          grew = true;
        }
    }
    return out;
  };
  function dropTarget(d: Drag, x: number, y: number): Drag["target"] {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-row-id]");
    const id = el?.dataset.rowId;
    if (!el || !id) return null;
    const target = byId.get(id);
    const moving = byId.get(d.id);
    if (!target || !moving || subtreeOf(d.id).has(id)) return null;
    const r = el.getBoundingClientRect();
    const rel = (y - r.top) / Math.max(1, r.height);
    let pos: DropPos = rel < 0.28 ? "before" : rel > 0.72 ? "after" : "inside";
    if (pos === "inside" && target.kind === "note") pos = rel < 0.5 ? "before" : "after";
    // Only areas sit at the top level; Miscellaneous stays last.
    if (pos !== "inside" && target.parentId === null && moving.kind !== "area") pos = "inside";
    if (pos === "after" && target.builtIn) pos = "before";
    if (pos === "inside" && target.kind === "note") return null;
    return { id, pos };
  }
  function drop(d: Drag) {
    const t = d.target;
    if (!t || !onPlace) return;
    const target = byId.get(t.id)!;
    if (t.pos === "inside") {
      const n = (kids.get(t.id) ?? []).filter((k) => k.id !== d.id && !k.archived).length;
      onPlace(d.id, t.id, n);
      return;
    }
    const parent = target.parentId;
    const sibs = (kids.get(parent) ?? []).filter((k) => k.id !== d.id && !k.archived);
    const i = sibs.findIndex((k) => k.id === t.id);
    onPlace(d.id, parent, Math.max(0, i) + (t.pos === "after" ? 1 : 0));
  }
  useEffect(() => {
    if (!drag?.active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setDrag(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag?.active]);
  const grip = (i: WorkItem) =>
    onPlace && !i.builtIn ? (
      <span
        aria-hidden="true"
        title="Drag to move"
        data-drag-handle={i.id}
        className="inline-flex h-9 w-5 shrink-0 cursor-grab touch-none items-center justify-center text-muted select-none active:cursor-grabbing"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e: ReactPointerEvent<HTMLSpanElement>) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          setDrag({ id: i.id, x: e.clientX, y: e.clientY, active: false, target: null });
        }}
        onPointerMove={(e) => {
          if (!drag || drag.id !== i.id) return;
          const active = drag.active || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4;
          if (!active) return;
          setDrag({ ...drag, active, target: dropTarget(drag, e.clientX, e.clientY) });
        }}
        onPointerUp={(e) => {
          if (!drag || drag.id !== i.id) return;
          e.currentTarget.releasePointerCapture?.(e.pointerId);
          if (drag.active) drop(drag);
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
      >
        <svg viewBox="0 0 12 16" className="h-4 w-3" fill="currentColor">
          <circle cx="3" cy="3" r="1.3" />
          <circle cx="9" cy="3" r="1.3" />
          <circle cx="3" cy="8" r="1.3" />
          <circle cx="9" cy="8" r="1.3" />
          <circle cx="3" cy="13" r="1.3" />
          <circle cx="9" cy="13" r="1.3" />
        </svg>
      </span>
    ) : null;

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
            data-row-id={i.id}
            className={cx(
              "relative flex min-h-11 cursor-pointer items-center gap-2 rounded-lg pr-2 text-sm",
              selected === i.id ? "bg-accent-soft text-accent font-medium" : "hover:bg-surface-2",
              i.archived && "opacity-60",
              drag?.active && drag.id === i.id && "opacity-50",
              drag?.active && drag.target?.id === i.id && drag.target.pos === "inside" && "ring-2 ring-accent",
              drag?.active && drag.target?.id === i.id && drag.target.pos === "before" && "shadow-[inset_0_2px_0_var(--accent)]",
              drag?.active && drag.target?.id === i.id && drag.target.pos === "after" && "shadow-[inset_0_-2px_0_var(--accent)]",
            )}
            style={{ paddingLeft: `${(level - 1) * 14 + 4}px` }}
          >
            {grip(i)}
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
      {/* Below the tree so showing it never shifts the rows under the pointer. */}
      {drag?.active ? (
        <p className="text-xs text-muted" aria-hidden="true">
          Drop on the top or bottom edge of a row to place it before or after; on the middle to put it inside. Esc cancels.
        </p>
      ) : null}
    </div>
  );
}
