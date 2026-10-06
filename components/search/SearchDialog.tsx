"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { SearchResponse, SearchResult } from "@/lib/search";
import { moduleFor } from "@/lib/modules";
import { cx, Spinner } from "@/components/ui";
import { SearchIcon } from "@/components/icons";

/** Any page can open search: window.dispatchEvent(new Event(OPEN_SEARCH_EVENT)). */
export const OPEN_SEARCH_EVENT = "jarvis:search";

const KIND_LABEL: Record<SearchResult["kind"], string> = {
  page: "Page",
  setting: "Settings",
  action: "Card",
  event: "Event",
  conversation: "Conversation",
  device: "Device",
  person: "Person",
  finance: "Finance",
};

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Ctrl K / "/" search across everything the person can see: pages, Home cards,
 * calendar events, conversations, home devices, finance items (never amounts)
 * and, for admins, people. Arrow keys move, Enter opens, Escape closes.
 */
export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const listId = useId();
  const debounced = useDebounced(q.trim(), 150);
  const res = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.get<SearchResponse>(`/api/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.length > 0,
    staleTime: 15_000,
  });
  const results = useMemo(() => (debounced ? (res.data?.results ?? []) : []), [res.data, debounced]);

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement | null;
    setQ("");
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
    return () => restore.current?.focus?.();
  }, [open]);

  if (!open) return null;
  const go = (r: SearchResult | undefined) => {
    if (!r) return;
    onClose();
    router.push(r.href);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-3 pt-[10vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div role="dialog" aria-modal="true" aria-label="Search" className="card w-full max-w-xl overflow-hidden p-0 shadow-xl">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <SearchIcon className="h-5 w-5 shrink-0 text-muted" />
          <input
            ref={input}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Search Jarvis"
            placeholder="Search pages, events, conversations, devices…"
            className="min-h-14 w-full bg-transparent text-base outline-none"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(results[active]);
              }
            }}
          />
          {res.isFetching ? <Spinner label="Searching" /> : null}
          <button type="button" onClick={onClose} className="tap rounded-lg px-2 text-sm text-muted hover:bg-surface-2">
            Esc
          </button>
        </div>
        <ul id={listId} role="listbox" aria-label="Results" className="max-h-[60vh] overflow-y-auto py-1">
          {results.map((r, i) => (
            <li
              key={r.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r)}
              className={cx("flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2", i === active && "bg-accent-soft")}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{r.title}</span>
                {r.subtitle ? <span className="block truncate text-sm text-muted">{r.subtitle}</span> : null}
              </span>
              <span className="shrink-0 text-xs text-muted">
                {KIND_LABEL[r.kind]}
                {r.module !== "jarvis" && moduleFor(r.module) ? ` · ${moduleFor(r.module)!.label}` : ""}
              </span>
            </li>
          ))}
        </ul>
        <div className="border-t border-line px-3 py-2 text-xs text-muted" role="status">
          {!debounced
            ? "Type to search. ↑↓ to move, Enter to open."
            : res.isError
              ? `Search failed: ${(res.error as Error).message}`
              : res.data && !results.length
                ? `Nothing found for “${debounced}”.`
                : res.data?.partial.length
                  ? `${results.length} results. ${res.data.partial.join(", ")} didn't answer in time.`
                  : results.length
                    ? `${results.length} result${results.length === 1 ? "" : "s"}`
                    : "Searching…"}
        </div>
      </div>
    </div>
  );
}
