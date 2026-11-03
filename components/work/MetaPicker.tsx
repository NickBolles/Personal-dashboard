"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cx } from "@/components/ui/kit";
import { useKeyboardInset } from "@/lib/client/keyboard";

/**
 * GitHub-label-style picker for the item header (tags, assignee): a compact icon
 * button that opens a popover (desktop/tablet) or a bottom sheet (phones, lifted
 * above the on-screen keyboard via `--kb-inset`). Search box on top, checkable
 * list, optional "Create …" row. ↑/↓ move, Enter toggles, Esc closes and returns
 * focus to the button; a click outside closes. Each toggle applies at once (the
 * caller saves it, so the item's Undo bar covers it).
 */
export type PickerOption = { value: string; label: string; section?: string; dot?: ReactNode; lead?: ReactNode; checked: boolean };

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
}) {
  useKeyboardInset();
  const id = useId();
  const listId = `${id}-list`;
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
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
  const cur = Math.min(active, Math.max(0, rows.length - 1));
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
    if (placed) input.current?.focus({ preventScroll: true });
  }, [placed]);

  const pick = (r: Row | undefined) => {
    if (!r) return;
    if (r.kind === "create") {
      onCreate?.(r.text);
      setQ("");
      setActive(0);
    } else onToggle(r.opt.value);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(rows.length ? (cur + 1) % rows.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(rows.length ? (cur - 1 + rows.length) % rows.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(rows[cur]);
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
        <input
          ref={input}
          role="combobox"
          aria-label={`Search ${label.toLowerCase()}`}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length ? `${listId}-${cur}` : undefined}
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
        <ul role="listbox" id={listId} aria-label={label} aria-multiselectable={multi || undefined} className="jv-pick-list">
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
                  data-active={i === cur || undefined}
                  className={cx("jv-pick-opt", r.kind === "create" && "jv-pick-create")}
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerMove={() => i !== cur && setActive(i)}
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
