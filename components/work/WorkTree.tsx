"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cx, inputCls } from "@/components/ui";
import { STATUS_LABELS, type LinkedConversationRow, type WorkItem } from "@/lib/work";
import { ChatIcon } from "@/components/icons";
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
 *
 * Areas (phase 4): conversations live in the same tree. Conversation nodes
 * (kind `conversation`) behave like any item (drag, nest, move); a
 * conversation an item merely links (work_links) shows as a read-only child
 * row of that item. Selecting either opens the conversation.
 */
export function WorkTree({
  items: realItems,
  selected,
  onSelect,
  onPlace,
  linked = [],
  onOpenConversation,
  selectedSession,
}: {
  items: WorkItem[];
  selected: string | null;
  onSelect: (id: string) => void;
  onPlace?: (id: string, parentId: string | null, index: number) => void;
  /** conversations linked to items, shown as their child rows */
  linked?: LinkedConversationRow[];
  /** open a conversation (node or linked row); without it conversation rows select like items */
  onOpenConversation?: (sessionId: string) => void;
  /** the open conversation (highlights its row) */
  selectedSession?: string | null;
}) {
  const { items, virtual } = useMemo(() => {
    const ids = new Set(realItems.map((i) => i.id));
    const virtual = new Set<string>();
    const extra: WorkItem[] = [];
    linked.forEach((l, n) => {
      if (!ids.has(l.itemId)) return;
      const id = `lc:${l.itemId}:${l.sessionId}`;
      if (virtual.has(id)) return;
      virtual.add(id);
      extra.push({
        id,
        parentId: l.itemId,
        kind: "conversation",
        title: l.title || "Conversation",
        summary: "",
        nextAction: "",
        status: "exploring",
        sortOrder: 1_000_000 + n,
        startDate: null,
        targetDate: null,
        completedAt: null,
        settledKind: null,
        settledReason: null,
        archived: false,
        builtIn: false,
        validationDefault: null,
        sessionId: l.sessionId,
        settings: null,
        createdAt: "",
        updatedAt: "",
      });
    });
    return { items: [...realItems, ...extra], virtual };
  }, [realItems, linked]);
  const activate = (i: WorkItem) => {
    if (i.kind === "conversation" && i.sessionId && onOpenConversation) onOpenConversation(i.sessionId);
    else if (!virtual.has(i.id)) onSelect(i.id);
  };
  const isSelected = (i: WorkItem) => selected === i.id || (!!selectedSession && i.sessionId === selectedSession);
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
        activate(item);
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
    if (!target || !moving || virtual.has(id) || subtreeOf(d.id).has(id)) return null;
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
    onPlace && !i.builtIn && !virtual.has(i.id) ? (
      <span
        aria-hidden="true"
        title="Drag to move"
        data-drag-handle={i.id}
        className="wk-grip inline-flex h-9 w-4 shrink-0 cursor-grab touch-none items-center justify-center text-muted select-none active:cursor-grabbing"
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
        <svg viewBox="0 0 12 16" className="h-3.5 w-2.5" fill="currentColor">
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
          aria-selected={isSelected(i)}
          aria-expanded={hasKids ? open : undefined}
          aria-label={
            virtual.has(i.id)
              ? `${i.title}, linked conversation`
              : `${i.title}, ${i.kind === "conversation" ? "conversation, " : ""}${STATUS_LABELS[i.status]}${i.archived ? ", archived" : ""}`
          }
          title={i.title}
          tabIndex={tabStop === i.id ? 0 : -1}
          onKeyDown={(e) => onKey(e, i)}
          onFocus={(e) => {
            if (e.target === e.currentTarget) setFocusId(i.id);
          }}
          onClick={(e) => {
            e.stopPropagation();
            setFocusId(i.id);
            activate(i);
          }}
          className="outline-none [&:focus-visible>div]:ring-2 [&:focus-visible>div]:ring-[var(--focus)]"
        >
          <div
            data-row-id={i.id}
            data-kind={i.kind}
            data-selected={isSelected(i) || undefined}
            className={cx(
              "wk-tree-row relative flex cursor-pointer items-center gap-1.5 pr-2 text-[13.5px]",
              !isSelected(i) && "hover:bg-surface",
              virtual.has(i.id) && "text-muted",
              level === 1 && "font-semibold",
              i.archived && "opacity-60",
              (i.status === "settled" || i.status === "superseded" || i.status === "abandoned") && selected !== i.id && "text-muted",
              drag?.active && drag.id === i.id && "opacity-50",
              drag?.active && drag.target?.id === i.id && drag.target.pos === "inside" && "ring-2 ring-accent",
              drag?.active && drag.target?.id === i.id && drag.target.pos === "before" && "shadow-[inset_0_2px_0_var(--accent)]",
              drag?.active && drag.target?.id === i.id && drag.target.pos === "after" && "shadow-[inset_0_-2px_0_var(--accent)]",
            )}
            style={{ paddingLeft: `${(level - 1) * 10 + 2}px` }}
          >
            {grip(i)}
            <span
              aria-hidden="true"
              className={cx("inline-flex h-6 w-4 shrink-0 items-center justify-center text-muted", !hasKids && "invisible")}
              onClick={(e) => {
                e.stopPropagation();
                toggle(i.id);
              }}
            >
              <svg viewBox="0 0 24 24" className={cx("h-3 w-3 transition-transform", open && "rotate-90")} fill="currentColor">
                <path d="M8 5l9 7-9 7z" />
              </svg>
            </span>
            {i.kind === "conversation" ? (
              <ChatIcon className={cx("h-3.5 w-3.5 shrink-0", i.status === "exploring" ? "text-muted" : "text-accent")} />
            ) : i.parentId === null && i.builtIn ? null : (
              <StatusDot status={i.status} />
            )}
            <span className="min-w-0 flex-1 truncate">{i.title}</span>
          </div>
          {hasKids && open ? <ul role="group">{render(i.id, level + 1)}</ul> : null}
        </li>
      );
    });
  };

  return (
    <div className="space-y-1.5">
      <label htmlFor="work-tree-filter" className="sr-only">
        Filter work
      </label>
      <input
        id="work-tree-filter"
        type="search"
        className={cx(inputCls, "border-line")}
        placeholder="Filter areas and chats…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {order.length ? (
        <ul role="tree" aria-label="Areas">
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
