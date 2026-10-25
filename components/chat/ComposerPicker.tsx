"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { cx, Spinner } from "@/components/ui";
import {
  COMMANDS,
  REF_TYPE_LABELS,
  REF_TYPES,
  matchCommands,
  parseRefQuery,
  type CommandId,
  type RefOption,
  type RefOptionsResponse,
  type Trigger,
} from "@/lib/references";

/** Debounced value (typing in the composer shouldn't fire a request per key). */
function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export type PickerRow =
  { kind: "ref"; option: RefOption } | { kind: "command"; id: CommandId; label: string; detail: string } | { kind: "filter"; type: string };

/**
 * The composer's trigger popover: `@` references (typed sections, `type:`
 * filters), `#` GitHub PRs/issues (scoped to a repo chip) and `/` commands.
 * A listbox driven from the textarea (aria-activedescendant), so focus never
 * leaves the composer: ↑/↓ move, Enter/Tab pick, Esc closes.
 */
export function useTriggerRows(trigger: Trigger | null, repo: string | null) {
  const query = useDebounced(trigger?.query ?? "", 150);
  const sigil = trigger?.sigil;
  const refs = useQuery({
    queryKey: ["composer", "refs", query],
    queryFn: () => api.get<RefOptionsResponse>(`/api/references?q=${encodeURIComponent(query)}`),
    enabled: sigil === "@",
    staleTime: 15_000,
  });
  const gh = useQuery({
    queryKey: ["composer", "gh", repo, query],
    queryFn: () =>
      api.get<RefOptionsResponse & { repo: string | null; searched: boolean }>(
        `/api/references/github?q=${encodeURIComponent(query)}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`,
      ),
    enabled: sigil === "#",
    staleTime: 15_000,
  });
  const rows = useMemo((): { section?: string; row: PickerRow }[] => {
    if (!trigger) return [];
    if (trigger.sigil === "/")
      return matchCommands(trigger.query).map((c) => ({ row: { kind: "command" as const, id: c.id, label: c.label, detail: c.detail } }));
    const data = trigger.sigil === "@" ? refs.data : gh.data;
    const out: { section?: string; row: PickerRow }[] = [];
    for (const s of data?.sections ?? []) for (const o of s.options) out.push({ section: s.label, row: { kind: "ref", option: o } });
    return out;
  }, [trigger, refs.data, gh.data]);
  const loading = trigger?.sigil === "@" ? refs.isFetching : trigger?.sigil === "#" ? gh.isFetching : false;
  const partial = (trigger?.sigil === "@" ? refs.data?.partial : gh.data?.partial) ?? [];
  const searched = gh.data?.searched ?? false;
  return { rows, loading, partial, searched };
}

export function TriggerPopover({
  trigger,
  rows,
  active,
  loading,
  partial,
  repo,
  searched,
  onRepo,
  onPick,
  onHover,
  onFilter,
  listId,
}: {
  trigger: Trigger;
  rows: { section?: string; row: PickerRow }[];
  active: number;
  loading: boolean;
  partial: string[];
  repo: string | null;
  searched: boolean;
  onRepo: (repo: string | null) => void;
  onPick: (row: PickerRow) => void;
  onHover: (i: number) => void;
  onFilter: (type: string) => void;
  listId: string;
}) {
  const id = useId();
  const [editingRepo, setEditingRepo] = useState(false);
  const typed = trigger.sigil === "@" ? parseRefQuery(trigger.query).type : undefined;
  const title = trigger.sigil === "@" ? "Reference" : trigger.sigil === "#" ? "Pull requests and issues" : "Commands";
  return (
    <div
      className="absolute inset-x-0 bottom-full z-30 mb-1.5 max-h-[min(60vh,360px)] overflow-y-auto rounded-[12px] border border-line bg-surface p-1 shadow-[var(--shadow-lg,var(--shadow))]"
      data-testid="composer-popover"
    >
      <div className="flex flex-wrap items-center gap-1 px-1.5 pt-1 pb-1.5">
        <span className="eyebrow mr-1">{title}</span>
        {trigger.sigil === "@"
          ? REF_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onFilter(t)}
                className="chip cursor-pointer"
                data-tone={typed === t ? "accent" : undefined}
                aria-pressed={typed === t}
              >
                {t}:
              </button>
            ))
          : null}
        {trigger.sigil === "#" ? (
          editingRepo ? (
            <input
              aria-label="Repository (owner/repo)"
              className="chip w-44 cursor-text"
              defaultValue={repo ?? ""}
              placeholder="owner/repo"
              autoFocus
              onBlur={(e) => {
                setEditingRepo(false);
                onRepo(e.target.value.trim() || null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          ) : (
            <button
              type="button"
              tabIndex={-1}
              className="chip cursor-pointer"
              data-tone="accent"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setEditingRepo(true)}
            >
              {repo ?? "any linked repo"} ▾
            </button>
          )
        ) : null}
        {loading ? <Spinner /> : null}
      </div>
      <ul role="listbox" id={listId} aria-label={title}>
        {rows.map(({ section, row }, i) => {
          const head = section && section !== rows[i - 1]?.section;
          const label = row.kind === "ref" ? row.option.label : row.kind === "command" ? row.label : row.type;
          const detail = row.kind === "ref" ? row.option.detail : row.kind === "command" ? row.detail : undefined;
          return (
            <li key={`${i}-${label}`} role="presentation">
              {head ? (
                <p role="presentation" className="px-2 pt-1.5 pb-0.5 text-[11px] font-semibold text-muted">
                  {section}
                </p>
              ) : null}
              <div
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(row)}
                className={cx("flex min-h-10 cursor-pointer items-center gap-2 rounded-[8px] px-2 text-[13.5px] dense:min-h-8", i === active && "bg-surface-2")}
              >
                <span className="min-w-0 truncate font-medium">{label}</span>
                {detail ? <span className="ml-auto min-w-0 shrink truncate text-xs text-muted">{detail}</span> : null}
              </div>
            </li>
          );
        })}
      </ul>
      {!rows.length && !loading ? (
        <p className="px-2 py-2 text-sm text-muted" id={`${id}-empty`}>
          {trigger.sigil === "/"
            ? "No command matches."
            : trigger.sigil === "#"
              ? repo && !searched
                ? `No GitHub access for ${repo}: only linked PRs and issues are listed.`
                : "Nothing matches."
              : "Nothing matches. Try a type: filter."}
        </p>
      ) : null}
      {partial.length ? <p className="px-2 pb-1 text-xs text-warn">{partial.join(", ")} didn&apos;t answer.</p> : null}
      <p className="hidden border-t border-line px-2 pt-1 text-[11px] text-muted lg:block">↑↓ choose · Enter pick · Esc close</p>
    </div>
  );
}

export const COMMAND_IDS = new Set(COMMANDS.map((c) => c.id));
export { REF_TYPE_LABELS };
