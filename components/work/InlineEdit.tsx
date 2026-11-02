"use client";

import { useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { cx, useToast } from "@/components/ui";
import { INLINE_LABELS, validateInline, type InlineField } from "@/lib/inline-edit";
import type { WorkStatus } from "@/lib/work";
import type { UndoOp } from "./UndoBar";

type Patch = Partial<Record<InlineField, string | null>> & { tags?: string[]; assignee?: string | null };

/** Rows without their own undo plumbing announce the server's edit op on window; the Areas view shows it. */
export const INLINE_OP_EVENT = "jarvis:inline-op";

/**
 * Optimistic PATCH for inline edits: the item detail and every cached item list
 * show the new value at once; on error they roll back and a toast explains.
 * Success hands the server's "edit" op to `onOp` (one "Saved · Undo" bar).
 */
export function useInlinePatch(id: string, onOp?: (op: UndoOp | null | undefined) => void) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (body: Patch) => api.patch<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(id)}`, body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: ["work"] });
      const snap: [QueryKey, unknown][] = qc.getQueriesData({ queryKey: ["work"] });
      const apply = (x: unknown): unknown => {
        if (!x || typeof x !== "object") return x;
        if (Array.isArray(x)) return x.map(apply);
        const o = x as Record<string, unknown>;
        if (o.id === id && "title" in o) return { ...o, ...body };
        if (o.item && typeof o.item === "object" && (o.item as { id?: string }).id === id) return { ...o, item: { ...(o.item as object), ...body } };
        if (Array.isArray(o.items)) return { ...o, items: o.items.map(apply) };
        return x;
      };
      for (const [key, data] of snap) qc.setQueryData(key, apply(data));
      return { snap };
    },
    onError: (e, _b, ctx) => {
      for (const [key, data] of ctx?.snap ?? []) qc.setQueryData(key, data);
      toast(`Not saved: ${(e as Error).message}`, "danger");
    },
    onSuccess: (r) => {
      if (onOp) onOp(r.op);
      else if (r.op) window.dispatchEvent(new CustomEvent(INLINE_OP_EVENT, { detail: r.op }));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["work"] }),
  });
}

/**
 * Tap/click-to-edit text. Enter (Ctrl/⌘+Enter when multiline) or blur saves,
 * Esc cancels. The read view keeps the same box so nothing jumps.
 */
export function InlineText({
  field,
  value,
  onSave,
  status,
  multiline,
  disabled,
  className,
  inputClassName,
  placeholder,
  children,
  editing: editingProp,
  onEditingChange,
  editButton,
}: {
  field: Exclude<InlineField, "status" | "targetDate">;
  value: string;
  onSave: (v: string) => void;
  status?: WorkStatus;
  multiline?: boolean;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  placeholder?: string;
  children?: ReactNode;
  editing?: boolean;
  onEditingChange?: (on: boolean) => void;
  /** read view = children + a separate "Edit" button (for content with its own controls) */
  editButton?: boolean;
}) {
  const [own, setOwn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draft = own ?? (editingProp ? value : null);
  const set = (v: string | null) => {
    setOwn(v);
    setError(null);
    onEditingChange?.(v !== null);
  };
  const label = INLINE_LABELS[field];
  const commit = () => {
    if (draft === null) return;
    const r = validateInline(field, draft, { status });
    if (!r.ok) return setError(r.error);
    if (r.value !== value) onSave(r.value ?? "");
    set(null);
  };
  if (draft !== null) {
    const common = {
      "aria-label": `Edit ${label.toLowerCase()}`,
      "aria-invalid": error ? true : undefined,
      "aria-describedby": error ? `ie-${field}-err` : undefined,
      autoFocus: true,
      value: draft,
      placeholder,
      className: cx("jv-inline-input", inputClassName),
      onBlur: commit,
      onChange: (e: { target: { value: string } }) => setOwn(e.target.value),
      onKeyDown: (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          set(null);
        } else if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
        }
      },
    };
    return (
      <span className={cx("jv-inline", className)} data-editing="">
        {multiline ? <textarea rows={3} {...common} /> : <input {...common} />}
        {error ? (
          <span id={`ie-${field}-err`} role="alert" className="jv-inline-err">
            {error}
          </span>
        ) : null}
      </span>
    );
  }
  if (disabled) return <span className={className}>{children ?? value}</span>;
  const open = (e: SyntheticEvent) => {
    e.stopPropagation();
    set(value);
  };
  // Rich read views (e.g. a summary with its own "More" toggle) keep their content and get a separate Edit button.
  if (editButton)
    return (
      <div className={cx("jv-inline-row", className)} data-inline-field={field}>
        <div className="min-w-0 flex-1">{children ?? (value || <span className="text-[13px] text-muted">{placeholder}</span>)}</div>
        <button type="button" className="wk-next-edit jv-inline-edit" aria-label={`Edit ${label.toLowerCase()}`} onClick={open}>
          Edit
        </button>
      </div>
    );
  return (
    <button
      type="button"
      className={cx("jv-inline jv-inline-read", className)}
      data-inline-field={field}
      // The name stays the content (headings keep their text); the hint is a description.
      title={`Edit ${label.toLowerCase()} (F2)`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "F2") {
          e.preventDefault();
          open(e);
        }
      }}
    >
      {children ?? (value || <span className="text-muted">{placeholder}</span>)}
    </button>
  );
}

/** "Due Nov 21" (year only when it isn't this year); short so the chip never pushes the header actions off the line. */
export function dueLabel(value: string | null, now = new Date()): string {
  if (!value) return "Set due date";
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return `Due ${value}`;
  const dt = new Date(y, m - 1, d);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (y !== now.getFullYear()) opts.year = "numeric";
  return `Due ${dt.toLocaleDateString("en-US", opts)}`;
}

/**
 * Inline due date: a short text chip ("Due Nov 21", truncates with an ellipsis) over a transparent
 * native date input, saved on change (cleared = no due date). Tapping the chip opens the picker.
 */
export function InlineDate({ value, onSave, className }: { value: string | null; onSave: (v: string | null) => void; className?: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <span className={cx("jv-inline jv-inline-date", className)} data-empty={value ? undefined : ""}>
      <span aria-hidden="true" className="jv-inline-date-text">
        {dueLabel(value)}
      </span>
      <input
        type="date"
        aria-label="Due date"
        className="jv-inline-date-input"
        value={value ?? ""}
        onClick={(e) => {
          e.stopPropagation();
          try {
            e.currentTarget.showPicker?.();
          } catch {
            /* picker needs a user gesture / unsupported: native behaviour still applies */
          }
        }}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const r = validateInline("targetDate", e.target.value);
          if (!r.ok) return setError(r.error);
          setError(null);
          if (r.value !== value) onSave(r.value);
        }}
      />
      {error ? (
        <span role="alert" className="jv-inline-err">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A row's title: a button that opens the item; F2 (and E where the view doesn't
 * already use it — not the Inbox, where E dismisses) edits the title in place.
 */
export function RowTitle({
  id,
  title,
  onOpen,
  className,
  editKeys = ["F2", "e", "E"],
  onOp,
}: {
  id: string;
  title: string;
  onOpen: () => void;
  className?: string;
  editKeys?: string[];
  onOp?: (op: UndoOp | null | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const save = useInlinePatch(id, onOp);
  if (editing)
    return (
      <InlineText
        field="title"
        value={title}
        editing
        onEditingChange={(on) => setEditing(on)}
        inputClassName="text-[14px] font-semibold"
        onSave={(t) => save.mutate({ title: t })}
      />
    );
  return (
    <button
      type="button"
      className={className}
      data-inline-row-title=""
      title="Open · F2 to rename"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (editKeys.includes(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          setEditing(true);
        }
      }}
    >
      {title}
    </button>
  );
}
