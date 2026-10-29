"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cx, inputCls } from "@/components/ui";
import { KIND_LABELS, STATUS_LABELS, isContainer, rollup, type LinkedConversationRow, type WorkItem } from "@/lib/work";
import { ChatIcon } from "@/components/icons";
import { StatusDot } from "./common";
import { InlineAdd } from "./QuickAdd";

type DropPos = "before" | "after" | "inside";
type Drag = { id: string; x: number; y: number; active: boolean; target: { id: string; pos: DropPos } | null };
type AddRow = { id: string; parentId: string | null };

const COLLAPSED_KEY = "jarvis.areas.collapsed";
function readCollapsed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const v = JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 2000) : []);
  } catch {
    return new Set();
  }
}

/** Folder-with-tab glyph for projects. */
export function ProjectIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cx("h-3.5 w-3.5 shrink-0 text-muted", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.6 3.5H3A1 1 0 0 0 2 4.5Z" />
    </svg>
  );
}

/**
 * Nested work tree (WAI-ARIA tree pattern): one tab stop, arrows move,
 * Right/Left expand/collapse (or go to parent), Enter/Space selects.
 * Rows hold no buttons so treeitems never nest interactive content.
 *
 * Structure editing: every open area/project ends with an "Add to …" row
 * (inline quick add with path syntax, Enter keeps adding); F2 or double-click
 * renames; Alt+→/← indent/outdent; Alt+↑/↓ reorder; M opens Move to…;
 * Ctrl/⌘-click (or select mode) selects rows for a bulk move. Collapsed rows
 * are remembered per browser.
 *
 * Drag-and-drop (pointer events, mouse/pen/touch) uses the grip on each row:
 * drop on the top or bottom quarter of a row to place before/after it, or the
 * middle to put it inside. Escape cancels.
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
  onCreated,
  onRename,
  onMove,
  selection,
  selectMode,
  onToggleSelect,
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
  /** turns on the inline add rows; called with what was created */
  onCreated?: (i: WorkItem) => void;
  onRename?: (id: string, title: string) => void;
  /** open Move to… for one item */
  onMove?: (id: string) => void;
  /** multi-select (bulk move/archive) */
  selection?: Set<string>;
  selectMode?: boolean;
  onToggleSelect?: (id: string) => void;
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
  const selectable = (i: WorkItem) => !!onToggleSelect && !virtual.has(i.id) && !i.builtIn;
  const activate = (i: WorkItem) => {
    if (selectMode && selectable(i)) onToggleSelect!(i.id);
    else if (i.kind === "conversation" && i.sessionId && onOpenConversation) onOpenConversation(i.sessionId);
    else if (!virtual.has(i.id)) onSelect(i.id);
  };
  const multi = !!selectMode || !!selection?.size;
  const isSelected = (i: WorkItem) => (multi ? !!selection?.has(i.id) : selected === i.id || (!!selectedSession && i.sessionId === selectedSession));
  const [drag, setDrag] = useState<Drag | null>(null);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [focusId, setFocusId] = useState<string | null>(selected);
  const [adding, setAdding] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const refocus = useRef<string | null>(null);
  const skipBlurCommit = useRef(false);
  useEffect(() => {
    const id = refocus.current;
    if (!id) return;
    const el = refs.current.get(id);
    if (el && document.activeElement !== el && (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected)) {
      el.focus();
      refocus.current = null;
    } else if (el && document.activeElement === el) refocus.current = null;
  }, [realItems]);
  const canAdd = !!onCreated && !selectMode;

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* private mode: just don't remember */
    }
  }, [collapsed]);

  const { kids, byId } = useMemo(() => {
    const kids = new Map<string | null, WorkItem[]>();
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const i of items) {
      const p = i.parentId && byId.has(i.parentId) ? i.parentId : null;
      kids.set(p, [...(kids.get(p) ?? []), i]);
    }
    return { kids, byId };
  }, [items]);

  const rollups = useMemo(() => {
    const m = new Map<string, ReturnType<typeof rollup>>();
    for (const i of realItems) if (isContainer(i) && !i.archived) m.set(i.id, rollup(realItems, i.id));
    return m;
  }, [realItems]);

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
  const showAdd = (i: WorkItem) => canAdd && !visibleSet && !virtual.has(i.id) && isContainer(i) && !i.archived;
  const order: (WorkItem | AddRow)[] = [];
  const walk = (parent: string | null) => {
    for (const i of kids.get(parent) ?? []) {
      if (visibleSet && !visibleSet.has(i.id)) continue;
      order.push(i);
      if (isOpen(i.id)) {
        walk(i.id);
        if (showAdd(i)) order.push({ id: `add:${i.id}`, parentId: i.id });
      }
    }
  };
  walk(null);
  if (canAdd && !visibleSet) order.push({ id: "add:", parentId: null });
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

  const realKids = (id: string | null) => (kids.get(id) ?? []).filter((k) => !virtual.has(k.id) && !k.archived);
  const parentKey = (i: WorkItem) => (i.parentId && byId.has(i.parentId) ? i.parentId : null);

  /** Keyboard structure edits (the drag-and-drop equivalents). Returns true when handled. */
  function structureKey(e: KeyboardEvent, item: WorkItem) {
    if (virtual.has(item.id) || item.builtIn) return false;
    const pk = parentKey(item);
    const sibs = realKids(pk);
    const idx = sibs.findIndex((s) => s.id === item.id);
    // The moved row remounts under its new parent once the tree refreshes: put focus back on it then.
    if (e.altKey && e.key.startsWith("Arrow")) refocus.current = item.id;
    if (e.altKey && onPlace && e.key === "ArrowUp") {
      if (idx > 0) onPlace(item.id, pk, idx - 1);
    } else if (e.altKey && onPlace && e.key === "ArrowDown") {
      if (idx >= 0 && idx < sibs.length - 1 && !sibs[idx + 1]?.builtIn) onPlace(item.id, pk, idx + 1);
    } else if (e.altKey && onPlace && e.key === "ArrowRight") {
      const prev = sibs[idx - 1];
      if (prev && prev.kind !== "note") {
        toggle(prev.id, true);
        onPlace(item.id, prev.id, realKids(prev.id).length);
      }
    } else if (e.altKey && onPlace && e.key === "ArrowLeft") {
      const parent = pk ? byId.get(pk) : undefined;
      if (!parent) return true;
      const grand = parentKey(parent);
      if (grand === null && item.kind !== "area") return true; // only areas sit at the top
      const up = realKids(grand).filter((s) => s.id !== item.id);
      onPlace(item.id, grand, up.findIndex((s) => s.id === parent.id) + 1);
    } else if (e.key === "F2" && onRename) setRenaming({ id: item.id, title: item.title });
    else if ((e.key === "m" || e.key === "M") && !e.altKey && !e.ctrlKey && !e.metaKey && onMove) onMove(item.id);
    else return false;
    return true;
  }

  function onAddKey(e: KeyboardEvent, row: AddRow) {
    const i = order.findIndex((o) => o.id === row.id);
    if (e.key === "ArrowDown") focus(order[i + 1]?.id);
    else if (e.key === "ArrowUp") focus(order[i - 1]?.id);
    else if (e.key === "ArrowLeft") focus(row.parentId ?? undefined);
    else if (e.key === "Home") focus(order[0]?.id);
    else if (e.key === "End") focus(order.at(-1)?.id);
    else if (e.key === "Enter" || e.key === " ") setAdding(row.id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onKey(e: KeyboardEvent, item: WorkItem) {
    if (e.target !== e.currentTarget) return; // typing in a rename box
    const i = order.findIndex((o) => o.id === item.id);
    const hasKids = !!kids.get(item.id)?.length || showAdd(item);
    if (structureKey(e, item)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
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
        else if (hasKids) focus(order[i + 1]?.id);
        break;
      case "ArrowLeft":
        if (hasKids && isOpen(item.id) && !visibleSet) toggle(item.id, false);
        else focus(item.parentId ?? undefined);
        break;
      case "Enter":
        activate(item);
        break;
      case " ":
        if (selectable(item) && (multi || e.shiftKey)) onToggleSelect!(item.id);
        else activate(item);
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

  function count(i: WorkItem) {
    const r = rollups.get(i.id);
    if (!r || virtual.has(i.id)) return null;
    const text = i.parentId === null ? (r.open ? String(r.open) : "") : r.total ? `${r.done}/${r.total}` : "";
    return text ? (
      <span aria-hidden="true" className="ml-1 shrink-0 text-[11px] font-normal text-muted tabular-nums">
        {text}
      </span>
    ) : null;
  }

  function commitRename(i: WorkItem) {
    // Enter/Escape already decided; the blur that follows moving focus back must not commit (again).
    if (skipBlurCommit.current) {
      skipBlurCommit.current = false;
      return;
    }
    const t = renaming?.title.trim();
    if (t && t !== i.title) onRename?.(i.id, t);
    setRenaming(null);
  }

  function addLi(parent: WorkItem | null, level: number) {
    const id = `add:${parent?.id ?? ""}`;
    if (adding === id)
      return (
        <li key={id} role="none" className="py-0.5" style={{ paddingLeft: `${(level - 1) * 14}px` }}>
          <InlineAdd
            parent={parent}
            onCreated={(n) => onCreated?.(n)}
            onDone={() => {
              setAdding(null);
              requestAnimationFrame(() => focus(id));
            }}
          />
        </li>
      );
    // Short visible label ("Add project" / "Add item", per the design tree); the accessible name keeps the parent.
    const what = parent?.parentId === null ? "project" : "item";
    const label = !parent ? "New area" : `Add ${what === "project" ? "a project" : "an item"} to ${parent.title}`;
    const shown = !parent ? "New area" : `Add ${what}`;
    return (
      <li
        key={id}
        id={`wt-${id}`}
        ref={(el) => {
          if (el) refs.current.set(id, el);
          else refs.current.delete(id);
        }}
        role="treeitem"
        aria-level={level}
        aria-selected={false}
        aria-label={label}
        data-add-row={parent?.id ?? "root"}
        tabIndex={tabStop === id ? 0 : -1}
        onKeyDown={(e) => onAddKey(e, { id, parentId: parent?.id ?? null })}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setFocusId(id);
        }}
        onClick={(e) => {
          e.stopPropagation();
          setFocusId(id);
          setAdding(id);
        }}
        className="outline-none [&:focus-visible>div]:ring-2 [&:focus-visible>div]:ring-[var(--focus)]"
      >
        <div
          className="wk-tree-row wk-add-row flex cursor-pointer items-center gap-1.5 pr-2 text-[12.5px] hover:bg-surface"
          style={{ paddingLeft: `${(level - 1) * 14 + 22}px` }}
        >
          <span aria-hidden="true" className="wk-plus">
            +
          </span>
          <span className="truncate">{shown}</span>
        </div>
      </li>
    );
  }

  const render = (parent: string | null, level: number) => {
    const list = (kids.get(parent) ?? []).filter((i) => !visibleSet || visibleSet.has(i.id));
    return list.map((i) => {
      const hasKids = !!kids.get(i.id)?.some((k) => !visibleSet || visibleSet.has(k.id)) || showAdd(i);
      const open = isOpen(i.id);
      const sel = isSelected(i);
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
          aria-selected={sel}
          aria-expanded={hasKids ? open : undefined}
          aria-label={
            virtual.has(i.id)
              ? `${i.title}, linked conversation`
              : `${i.title}, ${
                  i.parentId === null
                    ? "area"
                    : i.kind === "conversation" || i.kind === "project"
                      ? `${KIND_LABELS[i.kind].toLowerCase()}, ${STATUS_LABELS[i.status]}`
                      : STATUS_LABELS[i.status]
                }${i.archived ? ", archived" : ""}`
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
            if ((e.ctrlKey || e.metaKey || e.shiftKey) && selectable(i)) onToggleSelect!(i.id);
            else activate(i);
          }}
          className="outline-none [&:focus-visible>div]:ring-2 [&:focus-visible>div]:ring-[var(--focus)]"
        >
          <div
            data-row-id={i.id}
            data-kind={i.kind}
            data-selected={sel || undefined}
            className={cx(
              "wk-tree-row relative flex cursor-pointer items-center gap-1.5 pr-2 text-[13.5px]",
              !sel && "hover:bg-surface",
              virtual.has(i.id) && "text-muted",
              level === 1 && "font-semibold",
              i.archived && "opacity-60",
              (i.status === "settled" || i.status === "superseded" || i.status === "abandoned") && selected !== i.id && "text-muted",
              drag?.active && drag.id === i.id && "opacity-50",
              drag?.active && drag.target?.id === i.id && drag.target.pos === "inside" && "ring-2 ring-accent",
              drag?.active && drag.target?.id === i.id && drag.target.pos === "before" && "shadow-[inset_0_2px_0_var(--accent)]",
              drag?.active && drag.target?.id === i.id && drag.target.pos === "after" && "shadow-[inset_0_-2px_0_var(--accent)]",
            )}
            style={{ paddingLeft: `${(level - 1) * 14 + 2}px` }}
          >
            {multi && selectable(i) ? (
              <span
                aria-hidden="true"
                className={cx("h-3.5 w-3.5 shrink-0 rounded-[4px] border-[1.5px]", sel ? "border-accent bg-accent" : "border-line-strong")}
              />
            ) : (
              grip(i)
            )}
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
            ) : i.kind === "project" && i.parentId !== null ? (
              <ProjectIcon />
            ) : i.parentId === null ? null : (
              <StatusDot status={i.status} />
            )}
            {renaming?.id === i.id ? (
              <input
                aria-label={`Rename ${i.title}`}
                className="min-w-0 flex-1 rounded border border-accent bg-bg px-1.5 py-0.5 text-[13.5px]"
                autoFocus
                value={renaming.title}
                onFocus={() => {
                  skipBlurCommit.current = false;
                }}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenaming({ id: i.id, title: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    commitRename(i);
                    skipBlurCommit.current = true;
                    focus(i.id);
                  } else if (e.key === "Escape") {
                    skipBlurCommit.current = true;
                    setRenaming(null);
                    focus(i.id);
                  }
                }}
                onBlur={() => commitRename(i)}
              />
            ) : (
              <span
                className="min-w-0 flex-1 truncate"
                onDoubleClick={onRename && !i.builtIn && !virtual.has(i.id) ? () => setRenaming({ id: i.id, title: i.title }) : undefined}
              >
                {i.title}
              </span>
            )}
            {count(i)}
          </div>
          {hasKids && open ? (
            <ul role="group">
              {render(i.id, level + 1)}
              {showAdd(i) ? addLi(i, level + 1) : null}
            </ul>
          ) : null}
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
        <ul role="tree" aria-label="Areas" aria-multiselectable={multi || undefined}>
          {render(null, 1)}
          {canAdd && !visibleSet ? addLi(null, 1) : null}
        </ul>
      ) : (
        <p className="p-2 text-sm text-muted">{filter ? "Nothing matches." : "No areas yet."}</p>
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
