"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { cx } from "@/components/ui";
import { ChipButton } from "@/components/ui/kit";
import { AreaPickerDot, MetaPicker, SelectPicker, PersonIcon, TagIcon, type PickerOption } from "@/components/work/MetaPicker";
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
      <span className="jv-tag-name">#{name}</span>
      {onRemove ? (
        <button type="button" className="jv-tag-x" aria-label={`Remove tag ${name}`} onClick={onRemove}>
          ×
        </button>
      ) : null}
    </span>
  );
}

/** Row chips: assignee then tags, truncated to keep rows one line. */
export function ItemChips({ tags, assignee, max = 3, className }: { tags?: string[]; assignee?: string | null; max?: number; className?: string }) {
  const dir = useTagDirectory(!!(tags?.length || assignee));
  if (!tags?.length && !assignee) return null;
  const people = dir.data?.assignees.people ?? [];
  return (
    <span className={cx("jv-chips", className)}>
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

/**
 * Item header editor: assignee + tag pickers (compact buttons opening a
 * GitHub-label-style popover / phone sheet) and the item's tag chips.
 */
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
  const agents = dir.data?.assignees.agents ?? [];
  const people = dir.data?.assignees.people ?? [];
  const known = [...agents, ...people].some((o) => o.ref === assignee);
  const who = assigneeLabel(assignee, people);
  const assigneeOptions: PickerOption[] = [
    { value: "", label: "Unassigned", checked: !assignee },
    ...(assignee && !known ? [{ value: assignee, label: who ?? assignee, checked: true }] : []),
    ...agents.map((a) => ({
      value: a.ref,
      label: a.label,
      section: "Agents",
      checked: a.ref === assignee,
      lead: (
        <span className="jv-pick-av" aria-hidden="true">
          @
        </span>
      ),
    })),
    ...people.map((p) => ({
      value: p.ref,
      label: p.label,
      section: "People",
      checked: p.ref === assignee,
      lead: (
        <span className="jv-pick-av" aria-hidden="true">
          {(p.name || p.label).slice(0, 1).toUpperCase()}
        </span>
      ),
    })),
  ];
  const all = dir.data?.tags ?? [];
  const names = new Set([...all.map((t) => t.name), ...tags]);
  const tagOptions: PickerOption[] = [...names]
    .sort((a, b) => Number(tags.includes(b)) - Number(tags.includes(a)) || a.localeCompare(b))
    .map((name) => ({
      value: name,
      label: name,
      checked: tags.includes(name),
      dot: <span className={cx("jv-pick-dot", `jv-tag-${colorOf(name, all)}`)} aria-hidden="true" />,
    }));
  const toggleTag = (name: string) => onSave({ tags: tags.includes(name) ? tags.filter((x) => x !== name) : [...tags, name].sort() });
  return (
    <div className="jv-meta flex min-w-0 flex-wrap items-center gap-1.5">
      <MetaPicker
        label="Assignee"
        testId="assignee-picker"
        buttonLabel={who ? `Assignee: ${who}` : "Assignee: unassigned"}
        buttonClassName={cx(who && "jv-pick-btn-text")}
        value={assignee ?? ""}
        button={
          who ? (
            <>
              <span className="jv-pick-av" aria-hidden="true">
                {who.startsWith("@") ? "@" : who.slice(0, 1).toUpperCase()}
              </span>
              <span className="jv-pick-btn-label">{who}</span>
            </>
          ) : (
            <PersonIcon />
          )
        }
        options={assigneeOptions}
        onToggle={(v) => v !== (assignee ?? "") && onSave({ assignee: v || null })}
        placeholder="Assign to…"
        disabled={disabled}
      />
      {tags.map((t) => (
        <TagChip key={t} name={t} color={colorOf(t, all)} onRemove={disabled ? undefined : () => onSave({ tags: tags.filter((x) => x !== t) })} />
      ))}
      <MetaPicker
        label="Tags"
        testId="tag-picker"
        buttonLabel="Edit tags"
        value={tags.join(",")}
        button={<TagIcon />}
        options={tagOptions}
        multi
        onToggle={toggleTag}
        onCreate={(text) => {
          const t = normaliseTag(text);
          if (t && !tags.includes(t)) onSave({ tags: [...tags, t].sort() });
        }}
        createLabel={(text) => `Create “${normaliseTag(text) || text}”`}
        placeholder="Filter or create tags"
        disabled={disabled}
      />
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
  className,
}: {
  rows: { tags?: string[]; assignee?: string | null }[];
  value: ItemFilter;
  onChange: (f: ItemFilter) => void;
  idPrefix: string;
  className?: string;
}) {
  const used = rows.some((r) => r.tags?.length || r.assignee);
  const dir = useTagDirectory(used);
  if (!used && !value.tag && !value.assignee) return null;
  const tags = [...new Set(rows.flatMap((r) => r.tags ?? []))].sort();
  const refs = [...new Set(rows.map((r) => r.assignee).filter((a): a is string => !!a))];
  const people = dir.data?.assignees.people ?? [];
  return (
    <div
      className={cx("flex min-w-0 flex-wrap items-center gap-1.5", className)}
      role="group"
      aria-label="Filter by tag or assignee"
      data-testid={`${idPrefix}-filter`}
    >
      <label htmlFor={`${idPrefix}-tag`} className="sr-only">
        Filter by tag
      </label>
      <SelectPicker
        id={`${idPrefix}-tag`}
        label="Filter by tag"
        className="jv-meta-select"
        active={!!value.tag}
        value={value.tag ?? ""}
        onChange={(v) => onChange({ ...value, tag: v || null })}
        options={[
          { value: "", label: "All tags" },
          ...tags.map((t) => ({ value: t, label: `#${t}`, dot: <AreaPickerDot color={colorOf(t, dir.data?.tags)} /> })),
        ]}
      />
      <label htmlFor={`${idPrefix}-assignee`} className="sr-only">
        Filter by assignee
      </label>
      <SelectPicker
        id={`${idPrefix}-assignee`}
        label="Filter by assignee"
        className="jv-meta-select"
        active={!!value.assignee}
        value={value.assignee ?? ""}
        onChange={(v) => onChange({ ...value, assignee: v || null })}
        options={[
          { value: "", label: "Anyone" },
          { value: "none", label: "Unassigned" },
          ...refs.map((r) => ({ value: r, label: assigneeLabel(r, people) ?? r })),
        ]}
      />
      {value.tag || value.assignee ? <ChipButton onClick={() => onChange(NO_FILTER)}>Clear filter</ChipButton> : null}
    </div>
  );
}
