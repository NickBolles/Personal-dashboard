"use client";

import { useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { cx, inputCls } from "@/components/ui";
import { assigneeLabel, defaultTagColor, matchesItemFilter, normaliseTag, type TagColor, type WorkTag } from "@/lib/item-tags";

/**
 * Tags + assignee (#111): compact chips for rows and the inline editor for the
 * item header. Assigning to an agent is a label only; it never starts a run.
 */

export type AssigneeOption = { ref: string; label: string; id: string };
export type TagsResponse = { tags: WorkTag[]; assignees: { agents: AssigneeOption[]; people: (AssigneeOption & { name: string })[] } };

export function useTagDirectory(enabled = true) {
  return useQuery({ queryKey: ["work", "tags"], queryFn: () => api.get<TagsResponse>("/api/work/tags"), enabled, staleTime: 60_000 });
}

const colorOf = (name: string, tags: WorkTag[] | undefined): TagColor => tags?.find((t) => t.name === name)?.color ?? defaultTagColor(name);

/** Token-coloured chip: soft tint background + token text (works in light/dark). */
export function TagChip({ name, color, onRemove }: { name: string; color: TagColor; onRemove?: () => void }) {
  return (
    <span className={cx("jv-tag", `jv-tag-${color}`)} data-tag={name}>
      #{name}
      {onRemove ? (
        <button type="button" className="jv-tag-x" aria-label={`Remove tag ${name}`} onClick={onRemove}>
          ×
        </button>
      ) : null}
    </span>
  );
}

/** Row chips: assignee then tags, truncated to keep rows one line. */
export function ItemChips({ tags, assignee, max = 3 }: { tags?: string[]; assignee?: string | null; max?: number }) {
  const dir = useTagDirectory(!!(tags?.length || assignee));
  if (!tags?.length && !assignee) return null;
  const people = dir.data?.assignees.people ?? [];
  return (
    <span className="jv-chips" aria-label="Tags and assignee">
      {assignee ? (
        <span className="jv-assignee" data-assignee={assignee}>
          {assigneeLabel(assignee, people)}
        </span>
      ) : null}
      {tags?.slice(0, max).map((t) => (
        <TagChip key={t} name={t} color={colorOf(t, dir.data?.tags)} />
      ))}
      {tags && tags.length > max ? <span className="jv-tag jv-tag-more">+{tags.length - max}</span> : null}
    </span>
  );
}

/** Item header editor: assignee select + tag chips with an add field (Enter adds, creates on the fly). */
export function ItemMetaEditor({
  tags,
  assignee,
  onSave,
  disabled,
}: {
  tags: string[];
  assignee: string | null;
  onSave: (patch: { tags?: string[]; assignee?: string | null }) => void;
  disabled?: boolean;
}) {
  const dir = useTagDirectory();
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = normaliseTag(draft);
    setDraft("");
    if (t && !tags.includes(t)) onSave({ tags: [...tags, t].sort() });
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Escape") setDraft("");
  };
  const agents = dir.data?.assignees.agents ?? [];
  const people = dir.data?.assignees.people ?? [];
  const known = [...agents, ...people].some((o) => o.ref === assignee);
  return (
    <div className="jv-meta flex min-w-0 flex-wrap items-center gap-1.5">
      <label htmlFor="work-assignee" className="sr-only">
        Assignee
      </label>
      <select
        id="work-assignee"
        className={cx(inputCls, "jv-meta-select w-auto max-w-full")}
        value={assignee ?? ""}
        disabled={disabled}
        onChange={(e) => onSave({ assignee: e.target.value || null })}
      >
        <option value="">Unassigned</option>
        {assignee && !known ? <option value={assignee}>{assigneeLabel(assignee, people)}</option> : null}
        {agents.length ? (
          <optgroup label="Agents">
            {agents.map((a) => (
              <option key={a.ref} value={a.ref}>
                {a.label}
              </option>
            ))}
          </optgroup>
        ) : null}
        {people.length ? (
          <optgroup label="People">
            {people.map((p) => (
              <option key={p.ref} value={p.ref}>
                {p.label}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
      {tags.map((t) => (
        <TagChip key={t} name={t} color={colorOf(t, dir.data?.tags)} onRemove={disabled ? undefined : () => onSave({ tags: tags.filter((x) => x !== t) })} />
      ))}
      <input
        aria-label="Add tag"
        className={cx(inputCls, "jv-meta-tag-input min-w-0")}
        placeholder="+ tag"
        value={draft}
        disabled={disabled}
        list="work-tag-options"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => draft.trim() && add()}
      />
      <datalist id="work-tag-options">
        {(dir.data?.tags ?? [])
          .filter((t) => !tags.includes(t.name))
          .map((t) => (
            <option key={t.name} value={t.name} />
          ))}
      </datalist>
    </div>
  );
}

export type ItemFilter = { tag: string | null; assignee: string | null };
export const NO_FILTER: ItemFilter = { tag: null, assignee: null };

/** Applies a tag/assignee filter to any list of rows carrying tags/assignee. */
export function filterItems<T extends { tags?: string[]; assignee?: string | null }>(rows: T[], f: ItemFilter): T[] {
  if (!f.tag && !f.assignee) return rows;
  return rows.filter((r) => matchesItemFilter({ tags: r.tags ?? [], assignee: r.assignee ?? null }, f));
}

/**
 * Tag / assignee filter for lists (Today, Areas lists, Inbox filed, Activity).
 * Renders nothing until some row has a tag or an assignee, so untagged
 * workspaces look exactly as before.
 */
export function ItemFilterBar({
  rows,
  value,
  onChange,
  idPrefix,
}: {
  rows: { tags?: string[]; assignee?: string | null }[];
  value: ItemFilter;
  onChange: (f: ItemFilter) => void;
  idPrefix: string;
}) {
  const used = rows.some((r) => r.tags?.length || r.assignee);
  const dir = useTagDirectory(used);
  if (!used && !value.tag && !value.assignee) return null;
  const tags = [...new Set(rows.flatMap((r) => r.tags ?? []))].sort();
  const refs = [...new Set(rows.map((r) => r.assignee).filter((a): a is string => !!a))];
  const people = dir.data?.assignees.people ?? [];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Filter by tag or assignee" data-testid={`${idPrefix}-filter`}>
      <label htmlFor={`${idPrefix}-tag`} className="sr-only">
        Filter by tag
      </label>
      <select
        id={`${idPrefix}-tag`}
        className={cx(inputCls, "jv-meta-select w-auto max-w-full")}
        value={value.tag ?? ""}
        onChange={(e) => onChange({ ...value, tag: e.target.value || null })}
      >
        <option value="">All tags</option>
        {tags.map((t) => (
          <option key={t} value={t}>
            #{t}
          </option>
        ))}
      </select>
      <label htmlFor={`${idPrefix}-assignee`} className="sr-only">
        Filter by assignee
      </label>
      <select
        id={`${idPrefix}-assignee`}
        className={cx(inputCls, "jv-meta-select w-auto max-w-full")}
        value={value.assignee ?? ""}
        onChange={(e) => onChange({ ...value, assignee: e.target.value || null })}
      >
        <option value="">Anyone</option>
        <option value="none">Unassigned</option>
        {refs.map((r) => (
          <option key={r} value={r}>
            {assigneeLabel(r, people)}
          </option>
        ))}
      </select>
      {value.tag || value.assignee ? (
        <button type="button" className="tap text-[13px] text-accent underline" onClick={() => onChange(NO_FILTER)}>
          Clear filter
        </button>
      ) : null}
    </div>
  );
}
