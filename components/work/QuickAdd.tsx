"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Dialog, Field, inputCls } from "@/components/ui";
import { useWorkMutation } from "@/components/work/common";
import { itemPaths } from "@/components/work/conversations";
import { CREATABLE_KINDS, KIND_LABELS, defaultChildKind, parseQuickPath, type CreatableKind, type WorkItem } from "@/lib/work";

type PathResult = { item: WorkItem; created: number };

/** Kinds offered under a parent (areas only at the top). "Item" is the everyday name for a thread. */
export function kindOptions(parent: WorkItem | null): { value: CreatableKind; label: string }[] {
  if (!parent) return [{ value: "area", label: "Area" }];
  return CREATABLE_KINDS.filter((k) => k !== "area").map((k) => ({ value: k, label: k === "thread" ? "Item" : KIND_LABELS[k] }));
}

export function useCreatePath(onCreated?: (r: PathResult) => void) {
  return useWorkMutation(
    (v: { parentId: string | null; text: string; kind: CreatableKind; touched?: boolean }) => {
      const path = parseQuickPath(v.text);
      // With a path, the last level defaults to what its parent holds (a project holds items) unless the kind was picked.
      return api.post<PathResult>("/api/work/items/path", { parentId: v.parentId, path, kind: path.length > 1 && !v.touched ? undefined : v.kind });
    },
    {
      ok: undefined,
      onSuccess: (r) => onCreated?.(r),
    },
  );
}

const PATH_HINT = "Use “ / ” to nest: V5 evaluator / hydration fix creates the project if it’s missing.";

/**
 * "+ New" / "+ Project" / "+ Item": one dialog for every kind. The title takes
 * a path ("Project / item"); the destination defaults to where you are.
 */
export function QuickAddDialog({
  parent: initialParent,
  kind: initialKind,
  items,
  onClose,
  onCreated,
}: {
  parent: WorkItem | null;
  kind?: CreatableKind;
  items: WorkItem[];
  onClose: () => void;
  onCreated: (i: WorkItem) => void;
}) {
  const [parentId, setParentId] = useState<string>(initialKind === "area" ? "" : (initialParent?.id ?? ""));
  const parent = items.find((i) => i.id === parentId) ?? null;
  const [kind, setKind] = useState<CreatableKind>(initialKind ?? defaultChildKind(parent));
  const [touched, setTouched] = useState(false);
  const [text, setText] = useState("");
  const create = useCreatePath((r) => {
    onClose();
    onCreated(r.item);
  });
  const opts = kindOptions(parent);
  const effectiveKind = opts.some((o) => o.value === kind) ? kind : opts[0]!.value;
  const destinations = itemPaths(
    items.filter((i) => !i.archived),
    new Set(items.filter((i) => i.kind === "note" || i.kind === "conversation").map((i) => i.id)),
  );
  const segs = parseQuickPath(text);
  return (
    <Dialog
      open
      onClose={onClose}
      title={effectiveKind === "area" ? "New area" : `New ${opts.find((o) => o.value === effectiveKind)?.label.toLowerCase() ?? "item"}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="quick-add" type="submit" busy={create.isPending} disabled={!segs.length}>
            Create
          </Button>
        </>
      }
    >
      <form
        id="quick-add"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (segs.length) create.mutate({ parentId: parent?.id ?? null, text, kind: effectiveKind, touched });
        }}
      >
        <Field id="qa-title" label="Title" hint={effectiveKind === "area" ? undefined : PATH_HINT}>
          <input id="qa-title" data-autofocus required autoComplete="off" className={inputCls} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="qa-kind" label="Kind">
            <select
              id="qa-kind"
              className={inputCls}
              value={effectiveKind}
              onChange={(e) => {
                const k = e.target.value as CreatableKind;
                setKind(k);
                setTouched(true);
                if (k === "area") setParentId("");
              }}
            >
              {(parent ? opts : [{ value: "area" as const, label: "Area" }, ...kindOptions({ kind: "area", parentId: null } as WorkItem)]).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id="qa-parent" label="In">
            <select
              id="qa-parent"
              className={inputCls}
              value={effectiveKind === "area" ? "" : parentId}
              disabled={effectiveKind === "area"}
              onChange={(e) => {
                setParentId(e.target.value);
                const p = items.find((i) => i.id === e.target.value) ?? null;
                if (!initialKind) setKind(defaultChildKind(p));
              }}
            >
              <option value="">{effectiveKind === "area" ? "Top level" : "Miscellaneous (or the first part of the path)"}</option>
              {destinations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {segs.length > 1 ? (
          <p className="text-[13px] text-muted" data-testid="qa-preview">
            Creates {segs.slice(0, -1).join(" › ")} if missing, then <strong className="text-text">{segs.at(-1)}</strong>.
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * Inline "+ Add" row: type, Enter, keep typing. Path syntax works here too.
 * Escape (or an empty blur) closes it.
 */
export function InlineAdd({
  parent,
  onDone,
  onCreated,
  autoFocus = true,
  placeholder,
}: {
  parent: WorkItem | null;
  onDone?: () => void;
  onCreated?: (i: WorkItem) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const opts = kindOptions(parent);
  const [kind, setKind] = useState<CreatableKind>(defaultChildKind(parent));
  const [touched, setTouched] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const create = useCreatePath((r) => {
    setText("");
    onCreated?.(r.item);
    input.current?.focus();
  });
  const label = parent ? `Add to ${parent.title}` : "New area";
  return (
    <form
      className="wk-inline-add"
      aria-label={label}
      // Enter's implicit submit clicks the Add button; keep that click out of the tree row around us.
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        if (parseQuickPath(text).length) create.mutate({ parentId: parent?.id ?? null, text, kind, touched });
      }}
      onKeyDown={(e) => {
        e.stopPropagation(); // keep the tree's arrow/Enter handling out of the form
        if (e.key === "Escape") {
          e.preventDefault();
          onDone?.();
        }
      }}
    >
      <input
        ref={input}
        type="text"
        aria-label={parent ? `New item in ${parent.title}` : "New area name"}
        className={inputCls}
        autoFocus={autoFocus}
        autoComplete="off"
        value={text}
        placeholder={placeholder ?? (parent ? "Title, or Project / item…" : "Area name")}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          if (!text.trim() && !e.currentTarget.form?.contains(e.relatedTarget as Node)) onDone?.();
        }}
      />
      {opts.length > 1 ? (
        <select
          aria-label="Kind"
          className={inputCls}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as CreatableKind);
            setTouched(true);
          }}
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : null}
      <Button type="submit" size="sm" variant="primary" busy={create.isPending} disabled={!text.trim()}>
        Add
      </Button>
    </form>
  );
}
