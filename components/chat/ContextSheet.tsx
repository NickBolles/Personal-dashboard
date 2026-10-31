"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { HomePayload, JarvisNotification } from "@/lib/contracts";
import { encodeRef, type RefOptionsResponse } from "@/lib/references";
import { flattenSections, isFinanceContext } from "@/lib/chat-context";
import type { PanelLink } from "@/server/chat/links";
import { Button, Spinner, cx } from "@/components/ui";

/** A context chip above the composer. `token` (an @/# reference) is resolved server-side on send. */
export type ContextChip = { label: string; ref: string; token?: string };

type Row = { key: string; section: string; label: string; detail?: string; chip: ContextChip };

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/**
 * "Add context": one search box over areas, work, chats, people, devices, files
 * (the @ sources), GitHub (# prefix), today's tasks/alerts and this chat's
 * artifacts. Keyboard-first: ↑↓ move, Enter toggles (multi-select), Esc closes.
 * Bottom sheet on phones, a centred panel above the composer on wider screens.
 * Finance is never offered.
 */
export function ContextSheet({
  open,
  onClose,
  selected,
  onToggle,
  areaTitle,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  selected: ContextChip[];
  onToggle: (chip: ContextChip) => void;
  areaTitle?: string | null;
  sessionId: string;
}) {
  if (!open) return null;
  return <Sheet onClose={onClose} selected={selected} onToggle={onToggle} areaTitle={areaTitle} sessionId={sessionId} />;
}

function Sheet({
  onClose,
  selected,
  onToggle,
  areaTitle,
  sessionId,
}: {
  onClose: () => void;
  selected: ContextChip[];
  onToggle: (chip: ContextChip) => void;
  areaTitle?: string | null;
  sessionId: string;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const query = useDebounced(q.trim(), 150);
  const gh = query.startsWith("#");
  const listId = useId();
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restore.current = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => restore.current?.focus?.();
  }, []);

  const refs = useQuery({
    queryKey: ["composer", "refs", query],
    queryFn: () => api.get<RefOptionsResponse>(`/api/references?q=${encodeURIComponent(query)}`),
    enabled: !gh,
    staleTime: 15_000,
  });
  const ghq = useQuery({
    queryKey: ["composer", "gh", null, query.slice(1)],
    queryFn: () => api.get<RefOptionsResponse>(`/api/references/github?q=${encodeURIComponent(query.slice(1))}`),
    enabled: gh,
    staleTime: 15_000,
  });
  const home = useQuery({ queryKey: ["home", "cached"], queryFn: () => api.get<HomePayload>("/api/home?cached=1"), staleTime: 30_000 });
  const alerts = useQuery({
    queryKey: ["notifications", "inbox"],
    queryFn: () => api.get<{ notifications: JarvisNotification[] }>("/api/notifications"),
    staleTime: 30_000,
  });
  const links = useQuery({
    queryKey: ["chat-links", sessionId],
    queryFn: () => api.get<{ links: PanelLink[] }>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/links-panel`),
    staleTime: 15_000,
  });

  const rows = useMemo((): Row[] => {
    const out: Row[] = [];
    const ql = query.replace(/^#/, "").toLowerCase();
    const match = (s: string) => !ql || s.toLowerCase().includes(ql);
    const data = gh ? ghq.data : refs.data;
    for (const r of flattenSections(data?.sections ?? [], areaTitle ?? undefined))
      out.push({
        key: r.key,
        section: r.section,
        label: r.label,
        detail: r.detail,
        chip: { label: r.label, ref: `${r.type}:${r.id}`, token: encodeRef({ type: r.type, id: r.id, label: r.label }) },
      });
    if (!gh) {
      for (const l of links.data?.links ?? [])
        if (l.kind === "artifact" && match(`${l.title} ${l.slug ?? ""}`))
          out.push({ key: `link:${l.url}`, section: "Artifacts in this chat", label: l.title, detail: l.slug, chip: { label: l.title, ref: l.url } });
      const actions = [...(home.data?.now ?? []), ...(home.data?.later.laterToday ?? []), ...(home.data?.later.upcoming ?? [])];
      for (const a of actions.slice(0, 20))
        if (match(a.title) && !isFinanceContext({ type: a.source, label: a.title }))
          out.push({ key: `task:${a.id}`, section: "Tasks", label: a.title, detail: a.source, chip: { label: a.title, ref: `${a.source}:${a.sourceId}` } });
      for (const n of (alerts.data?.notifications ?? []).slice(0, 10))
        if (match(n.title) && !isFinanceContext({ id: n.id, label: n.title }))
          out.push({ key: `alert:${n.id}`, section: "Alerts", label: n.title, chip: { label: n.title, ref: `alert:${n.id}` } });
    }
    return out;
  }, [query, gh, ghq.data, refs.data, links.data, home.data, alerts.data, areaTitle]);

  const idx = Math.min(active, Math.max(0, rows.length - 1));
  const isOn = (c: ContextChip) => selected.some((s) => s.ref === c.ref);
  const loading = gh ? ghq.isFetching : refs.isFetching;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown" && rows.length) {
      e.preventDefault();
      setActive((a) => (Math.min(a, rows.length - 1) + 1) % rows.length);
    } else if (e.key === "ArrowUp" && rows.length) {
      e.preventDefault();
      setActive((a) => (Math.min(a, rows.length - 1) - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = rows[idx];
      if (r) onToggle(r.chip);
    }
  };

  useEffect(() => {
    document.getElementById(`${listId}-${idx}`)?.scrollIntoView?.({ block: "nearest" });
  }, [idx, listId]);

  return (
    <div className="fixed inset-0 z-50" onKeyDown={onKey}>
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="context-sheet"
        className="safe-bottom absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-2xl border border-line bg-surface shadow-xl sm:inset-x-auto sm:bottom-28 sm:left-1/2 sm:max-h-[70dvh] sm:w-[min(560px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:rounded-2xl"
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line sm:hidden" aria-hidden="true" />
        <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
          <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold">
            Add context
          </h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
        <div className="px-4 pt-2 pb-2">
          <label htmlFor={`${listId}-q`} className="sr-only">
            Search context
          </label>
          <input
            id={`${listId}-q`}
            ref={input}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows.length ? `${listId}-${idx}` : undefined}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            placeholder="Search areas, work, chats, people, files… (# for GitHub)"
            className="min-h-11 w-full min-w-0 rounded-xl border border-line bg-bg px-3 text-sm sm:min-h-10"
          />
          <p className="mt-1 text-[11px] text-muted" data-dynamic>
            ↑↓ move · Enter adds or removes · Esc closes{selected.length ? ` · ${selected.length} added` : ""}
          </p>
        </div>
        <ul id={listId} role="listbox" aria-label="Context results" aria-multiselectable="true" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {rows.map((r, i) => {
            const on = isOn(r.chip);
            const head = i === 0 || rows[i - 1]!.section !== r.section;
            return (
              <li key={r.key} role="presentation">
                {head ? (
                  <p role="presentation" className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                    {r.section}
                  </p>
                ) : null}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={on}
                  data-active={i === idx || undefined}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onToggle(r.chip)}
                  className={cx(
                    "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm sm:min-h-9",
                    i === idx ? "bg-surface-2" : "hover:bg-surface-2",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cx(
                      "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]",
                      on ? "border-accent bg-accent text-white" : "border-line",
                    )}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  {r.detail ? <span className="max-w-[40%] shrink-0 truncate text-xs text-muted">{r.detail}</span> : null}
                </div>
              </li>
            );
          })}
          {loading && !rows.length ? (
            <li role="presentation" className="px-2 py-2">
              <Spinner label="Searching…" />
            </li>
          ) : null}
          {!loading && !rows.length ? (
            <li role="presentation" className="px-2 py-2 text-sm text-muted">
              Nothing matches. Finance is never shared with the assistant.
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
