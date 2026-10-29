"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { SearchResponse, SearchResult } from "@/lib/search";
import { moduleFor } from "@/lib/modules";
import { cx, Spinner } from "@/components/ui";
import { SearchIcon } from "@/components/icons";
import { matchCommands, useCommands, type Command } from "@/components/navigation/commands";
import { useAccess } from "@/components/access";
import { useAskHermes } from "@/components/chat/useAskHermes";
import { useComposerTarget } from "@/components/agents/useComposerTarget";
import { ComposerTargetChip } from "@/components/agents/ComposerTargetChip";

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
  work: "Areas",
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
 * and, for admins, people. It is also the command palette: commands (Go to
 * Today/Inbox/…, Capture to Inbox, Start focused work, Record validation,
 * Continue in conversation) are listed first, filtered by what you type; the
 * command dock's action map runs the same commands. Arrow keys move, Enter
 * opens, Escape closes.
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
  const allCommands = useCommands();
  const commands = useMemo(() => matchCommands(allCommands, q.trim()).filter((c) => c.id !== "search"), [allCommands, q]);
  const { can } = useAccess();
  const canAsk = can("hermes.chat");
  // Area-contextual "Ask": inside an area/project/item it asks that area's agent and files the chat there.
  const target = useComposerTarget();
  const asker = useAskHermes();
  type Row = { kind: "command"; c: Command } | { kind: "result"; r: SearchResult } | { kind: "ask" };
  const askRow: Row[] = canAsk && q.trim() ? [{ kind: "ask" }] : [];
  const commandRows: Row[] = commands.map((c) => ({ kind: "command" as const, c }));
  // A matching command keeps Enter (“today” ↵ still goes to Today); otherwise Enter asks.
  const rows: Row[] = [...(commandRows.length ? [...commandRows, ...askRow] : [...askRow]), ...results.map((r) => ({ kind: "result" as const, r }))];

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement | null;
    setQ("");
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
    return () => restore.current?.focus?.();
  }, [open]);

  if (!open) return null;
  const go = (row: Row | undefined) => {
    if (!row) return;
    onClose();
    if (row.kind === "command") row.c.run();
    else if (row.kind === "ask") void asker.ask(q, { areaId: target.areaId, context: target.context });
    else router.push(row.r.href);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 p-3 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="w-full max-w-[620px] overflow-hidden rounded-[14px] border border-line bg-surface shadow-[var(--shadow-pop)]"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <SearchIcon className="h-[18px] w-[18px] shrink-0 text-muted" />
          <input
            ref={input}
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Search Jarvis"
            placeholder="Search, or type a command (“today”, “capture”, “validate”)…"
            className="min-h-[52px] w-full bg-transparent text-base outline-none placeholder:text-muted"
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
                setActive((i) => Math.min(i + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canAsk && q.trim()) {
                e.preventDefault();
                go({ kind: "ask" });
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(rows[active]);
              }
            }}
          />
          {res.isFetching ? <Spinner label="Searching" /> : null}
          {canAsk ? <ComposerTargetChip target={target} /> : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search (Esc)"
            className="tap inline-flex shrink-0 items-center justify-center rounded-[8px] px-1.5 hover:bg-surface-2"
          >
            <kbd className="kbd">Esc</kbd>
          </button>
        </div>
        <ul id={listId} role="listbox" aria-label="Commands and results" className="max-h-[60vh] overflow-y-auto p-1.5">
          {rows.map((row, i) => (
            <li
              key={row.kind === "command" ? `cmd:${row.c.id}` : row.kind === "ask" ? "ask" : row.r.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              data-command={row.kind === "command" ? row.c.id : undefined}
              data-testid={row.kind === "ask" ? "palette-ask" : undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(row)}
              className={cx(
                "flex min-h-11 cursor-pointer items-center gap-3 rounded-[8px] px-2.5 py-1.5 sm:min-h-10 dense:min-h-8",
                i === active && "bg-accent-soft",
                // a hairline between command groups, so the group label only needs saying once
                i > 0 && row.kind === "command" && rows[i - 1]?.kind === "command" && (rows[i - 1] as { c: Command }).c.group !== row.c.group && "mt-1.5",
              )}
            >
              {row.kind === "ask" ? (
                <>
                  <span aria-hidden="true" className="w-4 shrink-0 text-center text-xs text-accent">
                    ✦
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">Ask {target.agent}</span>
                    {target.node ? <span className="text-muted"> · {target.node.title}</span> : null}
                    <span className="text-muted">: “{q.trim()}”</span>
                  </span>
                  <kbd className="kbd shrink-0">{commandRows.length ? "Ctrl ↵" : "↵"}</kbd>
                </>
              ) : row.kind === "command" ? (
                <>
                  <span aria-hidden="true" className="w-4 shrink-0 text-center font-mono text-xs text-muted">
                    ›
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{row.c.label}</span>
                  {i === 0 || rows[i - 1]?.kind !== "command" || (rows[i - 1] as { c: Command }).c.group !== row.c.group ? (
                    <span className="eyebrow shrink-0">{row.c.group}</span>
                  ) : (
                    <span className="sr-only">{row.c.group}</span>
                  )}
                </>
              ) : (
                <>
                  <span aria-hidden="true" className="w-4 shrink-0 text-center font-mono text-xs text-muted">
                    ·
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{row.r.title}</span>
                    {row.r.subtitle ? <span className="block truncate text-sm text-muted">{row.r.subtitle}</span> : null}
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {KIND_LABEL[row.r.kind]}
                    {row.r.module !== "jarvis" && moduleFor(row.r.module) ? ` · ${moduleFor(row.r.module)!.label}` : ""}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="border-t border-line bg-surface-2 px-4 py-2 text-xs text-muted" role="status">
          {!debounced ? (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move
              </span>
              <span>
                <kbd className="kbd">↵</kbd> open
              </span>
              <span>
                <kbd className="kbd">Ctrl</kbd> <kbd className="kbd">.</kbd> or hold the orb: action map
              </span>
              <span className="sr-only">Type to search or filter commands.</span>
            </span>
          ) : res.isError ? (
            `Search failed: ${(res.error as Error).message}`
          ) : res.data && !results.length ? (
            `Nothing found for “${debounced}”.`
          ) : res.data?.partial.length ? (
            `${results.length} results. ${res.data.partial.join(", ")} didn't answer in time.`
          ) : results.length ? (
            `${results.length} result${results.length === 1 ? "" : "s"}`
          ) : (
            "Searching…"
          )}
        </div>
      </div>
    </div>
  );
}
