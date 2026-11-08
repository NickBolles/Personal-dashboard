"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cx } from "@/components/ui/kit";
import { useKeyboardInset } from "@/lib/client/keyboard";
import type { TagColor } from "@/lib/item-tags";
import { validateInline } from "@/lib/inline-edit";
import { dueLabel } from "./InlineEdit";

/**
 * GitHub-label-style picker for the item header (tags, assignee): a compact icon
 * button that opens a popover (desktop/tablet) or a bottom sheet (phones, lifted
 * above the on-screen keyboard via `--kb-inset`). Search box on top, checkable
 * list, optional "Create …" row. ↑/↓ move, Enter toggles, Esc closes and returns
 * focus to the button; a click outside closes. Each toggle applies at once (the
 * caller saves it, so the item's Undo bar covers it).
 */
export type PickerOption = { value: string; label: string; section?: string; dot?: ReactNode; lead?: ReactNode; checked: boolean; disabled?: boolean };

export function MetaPicker({
  label,
  buttonLabel,
  button,
  buttonClassName,
  options,
  onToggle,
  onCreate,
  createLabel,
  placeholder,
  disabled,
  multi,
  testId,
  value,
}: {
  /** Dialog/list name, e.g. "Tags". */
  label: string;
  /** Accessible name of the opener, e.g. "Edit tags" or "Assignee: @devchief". */
  buttonLabel: string;
  button: ReactNode;
  buttonClassName?: string;
  options: PickerOption[];
  onToggle: (value: string) => void;
  /** Offered when the search text has no exact match; returns nothing (the caller saves). */
  onCreate?: (text: string) => void;
  createLabel?: (text: string) => string;
  placeholder: string;
  disabled?: boolean;
  multi?: boolean;
  testId?: string;
  /** Current value mirrored on the opener (`data-value`) for tests and styling. */
  value?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  return (
    <span className="jv-pick-wrap" data-testid={testId}>
      <button
        ref={btn}
        type="button"
        className={cx("jv-pick-btn", buttonClassName)}
        aria-label={buttonLabel}
        title={buttonLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-value={value ?? ""}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {button}
      </button>
      {open ? (
        <PickerPanel
          label={label}
          options={options}
          onToggle={(v) => {
            onToggle(v);
            if (!multi) close();
          }}
          onCreate={
            onCreate
              ? (t) => {
                  onCreate(t);
                  if (!multi) close();
                }
              : undefined
          }
          createLabel={createLabel}
          placeholder={placeholder}
          multi={multi}
          onClose={close}
          opener={btn}
        />
      ) : null}
    </span>
  );
}

export function StatusPickerDot({ status }: { status: string }) {
  return <span className="wk-dot" data-s={status} aria-hidden="true" />;
}

export function AreaPickerDot({ color }: { color?: TagColor | null }) {
  return <span className={cx("jv-pick-dot", color && `jv-tag-${color}`)} aria-hidden="true" />;
}

function PickerCaret() {
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

export type SelectPickerOption = Omit<PickerOption, "checked" | "lead">;

export function SelectPicker({
  id,
  label,
  value,
  options,
  onChange,
  active = !!value,
  testId,
  className,
  triggerLabel,
  icon,
  disabled,
  "data-s": status,
}: {
  id?: string;
  label: string;
  value: string;
  options: SelectPickerOption[];
  onChange: (value: string) => void;
  active?: boolean;
  testId?: string;
  className?: string;
  triggerLabel?: string;
  icon?: ReactNode;
  disabled?: boolean;
  "data-s"?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const selected = options.find((o) => o.value === value);
  const current = selected?.label ?? value;
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  return (
    <span className="jv-pick-wrap">
      <button
        ref={btn}
        id={id}
        type="button"
        className={cx("k-pick k-pick-btn jv-select-btn min-h-11 sm:min-h-10 dense:min-h-8", active && "k-pick-on", className)}
        aria-label={`${label}: ${current}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-value={value}
        data-s={status}
        data-testid={testId}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
        {selected?.dot}
        <span className="jv-pick-label">{triggerLabel ?? current}</span>
        <PickerCaret />
      </button>
      {open ? (
        <PickerPanel
          label={label}
          options={options.map((o) => ({ ...o, checked: o.value === value }))}
          searchable={options.length > 7}
          placeholder={`Search ${label.toLowerCase()}`}
          onToggle={(v) => {
            if (v !== value) onChange(v);
            close();
          }}
          onClose={close}
          opener={btn}
        />
      ) : null}
    </span>
  );
}

/** Local calendar arithmetic, not elapsed milliseconds/UTC. Next week is the next Monday (seven days away on Monday). */
export function quickDueDates(now: Date) {
  const date = (offset: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  return { today: date(0), tomorrow: date(1), nextWeek: date((8 - now.getDay()) % 7 || 7) };
}

/** Pause after the last keyboard segment edit before a typed custom due date is saved. */
export const DUE_EDIT_SETTLE_MS = 700;

export function DuePicker({ value, onSave, className }: { value: string | null; onSave: (v: string | null) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(pending.current), []);
  const dates = quickDueDates(new Date());
  // #231: a custom date parked when focus moved to a preset row; a preset discards it, dismissing saves it.
  const draft = useRef<string | undefined>(undefined);
  const close = (refocus = true) => {
    clearTimeout(pending.current);
    pending.current = undefined;
    draft.current = undefined;
    setOpen(false);
    setCustom(false);
    if (refocus) btn.current?.focus();
  };
  const flush = (raw: string) => {
    clearTimeout(pending.current);
    pending.current = undefined;
    if (raw) save(raw);
  };
  const save = (raw: string) => {
    const r = validateInline("targetDate", raw);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    if (r.value !== value) onSave(r.value);
    close();
  };
  const choices = [
    { value: "today", label: "Today", date: dates.today },
    { value: "tomorrow", label: "Tomorrow", date: dates.tomorrow },
    { value: "nextWeek", label: "Next week", date: dates.nextWeek },
    { value: "custom", label: "Pick a date…", date: undefined },
    ...(value ? [{ value: "clear", label: "Clear due date", date: "" }] : []),
  ];
  const selected = choices.findIndex((o) => o.date === value);
  const options = choices.map((o, i) => ({ ...o, checked: i === selected }));
  return (
    <span className="jv-pick-wrap">
      <button
        ref={btn}
        type="button"
        className={cx("k-pick k-pick-btn min-h-11 sm:min-h-10 dense:min-h-8", value && "k-pick-on", className)}
        aria-label={`Due date: ${dueLabel(value)}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-value={value ?? ""}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="jv-pick-label">{dueLabel(value)}</span>
        <PickerCaret />
      </button>
      {open ? (
        <PickerPanel
          label="Due date"
          options={options}
          searchable={false}
          placeholder=""
          opener={btn}
          onClose={(refocus) => {
            const d = draft.current;
            draft.current = undefined;
            if (d) save(d);
            else close(refocus);
          }}
          onToggle={(v) => {
            if (v === "custom") return setCustom(true);
            draft.current = undefined;
            save(choices.find((o) => o.value === v)?.date ?? "");
          }}
          footer={
            custom ? (
              <div className="p-2">
                <input
                  autoFocus
                  type="date"
                  aria-label="Due date"
                  className="jv-pick-search max-w-full"
                  defaultValue={value ?? ""}
                  onChange={(e) => {
                    // Keyboard edits change one segment at a time (each a valid date): save once editing pauses,
                    // or right away on Enter/blur, so the editor stays open between segments (#207).
                    const raw = e.target.value;
                    draft.current = undefined;
                    if (pending.current) clearTimeout(pending.current);
                    pending.current = raw ? setTimeout(() => flush(raw), DUE_EDIT_SETTLE_MS) : undefined;
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    flush(e.currentTarget.value);
                  }}
                  onBlur={(e) => {
                    // #231: focus moving to a preset inside this portalled picker must not commit the custom date
                    // and unmount the picker before the preset's click (mousedown → blur → long press → click).
                    // Pause the settle timer and park the edit: a preset discards it, dismissing the picker saves it.
                    if (e.relatedTarget instanceof Node && e.currentTarget.closest('[role="dialog"]')?.contains(e.relatedTarget)) {
                      if (pending.current) {
                        clearTimeout(pending.current);
                        pending.current = undefined;
                        draft.current = e.currentTarget.value || undefined;
                      }
                      return;
                    }
                    if (pending.current) flush(e.currentTarget.value);
                  }}
                />
                {error ? <p role="alert">{error}</p> : null}
              </div>
            ) : null
          }
        />
      ) : null}
    </span>
  );
}

type Row = { kind: "opt"; opt: PickerOption } | { kind: "create"; text: string };

function PickerPanel({
  label,
  options,
  onToggle,
  onCreate,
  createLabel,
  placeholder,
  multi,
  onClose,
  opener,
  searchable = true,
  footer,
}: {
  label: string;
  options: PickerOption[];
  onToggle: (value: string) => void;
  onCreate?: (text: string) => void;
  createLabel?: (text: string) => string;
  placeholder: string;
  multi?: boolean;
  onClose: (refocus?: boolean) => void;
  opener: RefObject<HTMLButtonElement | null>;
  searchable?: boolean;
  footer?: ReactNode;
}) {
  useKeyboardInset();
  const id = useId();
  const listId = `${id}-list`;
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const [q, setQ] = useState("");
  const [active, setActive] = useState(() => {
    const selected = options.findIndex((o) => o.checked);
    return selected >= 0
      ? selected
      : Math.max(
          0,
          options.findIndex((o) => !o.disabled),
        );
  });
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  const rows = useMemo((): Row[] => {
    const needle = q.trim().toLowerCase();
    const hits = options.filter((o) => !needle || o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle));
    const out: Row[] = hits.map((opt) => ({ kind: "opt", opt }));
    const exact = options.some((o) => o.label.toLowerCase().replace(/^[#@]/, "") === needle.replace(/^[#@]/, "") || o.value.toLowerCase() === needle);
    if (onCreate && needle && !exact) out.push({ kind: "create", text: q.trim() });
    return out;
  }, [q, options, onCreate]);
  const bounded = Math.min(active, Math.max(0, rows.length - 1));
  const enabled = (r: Row) => r.kind === "create" || !r.opt.disabled;
  // An existing disabled value (e.g. Settled) is still the initial active row;
  // it can be read but never picked. Filtering starts at an enabled match.
  const cur = !rows.length ? -1 : q && !enabled(rows[bounded]) ? rows.findIndex(enabled) : bounded;
  // Keep the highlighted row visible while ↑/↓ walk past the list's capped height (#164).
  useEffect(() => {
    document.getElementById(`${listId}-${cur}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, cur]);

  // Desktop/tablet: a fixed popover anchored under the opener (portalled, so no header can clip it).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const place = () => {
      const r = opener.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(272, window.innerWidth - 24);
      setPos({ top: Math.round(r.bottom + 4), left: Math.round(Math.max(12, Math.min(r.left, window.innerWidth - w - 12))) });
    };
    place();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || opener.current?.contains(t)) return;
      closeRef.current(false);
    };
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onEsc, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onEsc, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [opener]);

  // Focus the filter once the placed panel is visible (a hidden input ignores focus()).
  const placed = pos !== null;
  useEffect(() => {
    if (placed) (searchable ? input.current : list.current)?.focus({ preventScroll: true });
  }, [placed, searchable]);

  const pick = (r: Row | undefined) => {
    if (!r || !enabled(r)) return;
    if (r.kind === "create") {
      onCreate?.(r.text);
      setQ("");
      setActive(0);
    } else onToggle(r.opt.value);
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const available = rows.flatMap((r, i) => (enabled(r) ? [i] : []));
      const next =
        e.key === "Home"
          ? available[0]
          : e.key === "End"
            ? available.at(-1)
            : e.key === "ArrowDown"
              ? (available.find((i) => i > cur) ?? available[0])
              : (available.filter((i) => i < cur).at(-1) ?? available.at(-1));
      if (next !== undefined) setActive(next);
    } else if (e.key === "Enter" || (!searchable && e.key === " ")) {
      e.preventDefault();
      pick(rows[cur]);
    } else if (!searchable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const now = Date.now();
      const prefix = (now - typed.current.at < 600 ? typed.current.text : "") + e.key.toLowerCase();
      typed.current = { text: prefix, at: now };
      const repeated = [...prefix].every((c) => c === prefix[0]);
      const needle = repeated ? prefix[0] : prefix;
      // Continue multi-character prefixes at the current row; repeated letters cycle matches.
      const start = prefix.length > 1 && !repeated ? cur : cur + 1;
      for (let n = 0; n < rows.length; n++) {
        const i = (start + n + rows.length) % rows.length;
        const r = rows[i];
        if (enabled(r) && r.kind === "opt" && r.opt.label.toLowerCase().startsWith(needle)) {
          setActive(i);
          break;
        }
      }
    }
  };

  return createPortal(
    <>
      <div className="jv-pick-scrim" aria-hidden="true" onClick={() => onClose()} />
      <div
        ref={panel}
        role="dialog"
        aria-label={label}
        className="jv-pick-pop"
        style={pos ? ({ "--pick-top": `${pos.top}px`, "--pick-left": `${pos.left}px` } as CSSProperties) : { visibility: "hidden" }}
      >
        <div className="jv-pick-head">
          <span className="jv-pick-title">{label}</span>
          <button type="button" className="jv-pick-done" onClick={() => onClose()}>
            Done
          </button>
        </div>
        {searchable ? (
          <input
            ref={input}
            role="combobox"
            aria-label={`Search ${label.toLowerCase()}`}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows.length && cur >= 0 ? `${listId}-${cur}` : undefined}
            className="jv-pick-search"
            placeholder={placeholder}
            value={q}
            autoComplete="off"
            enterKeyHint="done"
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
        ) : null}
        <ul
          ref={list}
          role="listbox"
          id={listId}
          aria-label={label}
          aria-multiselectable={multi || undefined}
          className="jv-pick-list"
          tabIndex={searchable ? undefined : 0}
          aria-activedescendant={!searchable && cur >= 0 && rows.length ? `${listId}-${cur}` : undefined}
          onKeyDown={searchable ? undefined : onKey}
        >
          {rows.map((r, i) => {
            const head =
              r.kind === "opt" &&
              r.opt.section &&
              r.opt.section !== (rows[i - 1]?.kind === "opt" ? (rows[i - 1] as { opt: PickerOption }).opt.section : undefined);
            return (
              <li key={r.kind === "opt" ? r.opt.value || "∅" : "create"} role="presentation">
                {head && r.kind === "opt" ? (
                  <p role="presentation" className="jv-pick-sec">
                    {r.opt.section}
                  </p>
                ) : null}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={r.kind === "opt" ? r.opt.checked : false}
                  aria-disabled={r.kind === "opt" && r.opt.disabled ? true : undefined}
                  data-active={i === cur || undefined}
                  className={cx("jv-pick-opt", r.kind === "create" && "jv-pick-create")}
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerMove={() => enabled(r) && i !== cur && setActive(i)}
                  onClick={() => pick(r)}
                >
                  {r.kind === "opt" ? (
                    <>
                      <span className="jv-pick-check" aria-hidden="true">
                        {r.opt.checked ? (
                          <svg
                            viewBox="0 0 16 16"
                            width="14"
                            height="14"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M3.5 8.5l3 3 6-7" />
                          </svg>
                        ) : null}
                      </span>
                      {r.opt.dot ?? r.opt.lead ?? null}
                      <span className="jv-pick-label">{r.opt.label}</span>
                    </>
                  ) : (
                    <>
                      <span className="jv-pick-check" aria-hidden="true">
                        +
                      </span>
                      <span className="jv-pick-label">{createLabel ? createLabel(r.text) : `Create “${r.text}”`}</span>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {!rows.length ? <p className="jv-pick-empty">Nothing matches.</p> : null}
        {footer}
      </div>
    </>,
    document.body,
  );
}

export function TagIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 2.75v4.1c0 .3.12.58.33.8l6.02 6.02a1.1 1.1 0 0 0 1.56 0l4.04-4.04a1.1 1.1 0 0 0 0-1.56L7.93 2.05A1.1 1.1 0 0 0 7.15 1.75H3a1 1 0 0 0-1 1Z" />
      <circle cx="5" cy="4.75" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PersonIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="5.5" r="2.75" />
      <path d="M2.75 14c.6-2.6 2.7-4 5.25-4s4.65 1.4 5.25 4" />
    </svg>
  );
}
