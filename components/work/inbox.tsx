"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/client/api";
import { Badge, Button, Dialog, ErrorNote, Field, OverflowMenu, Spinner, cx, inputCls } from "@/components/ui";
import { useAccess } from "@/components/access";
import { useWorkMutation } from "@/components/work/common";
import { UnfiledPanel, fmtWhen, itemPaths } from "@/components/work/conversations";
import { useInbox } from "@/components/work/today";
import { CaptureSheet } from "@/components/capture/CaptureSheet";
import { CaptureExtras, CaptureRowMenu } from "@/components/capture/CaptureExtras";
import type { InboxEntry, WorkItem } from "@/lib/work";

/**
 * The Work inbox: assigned GitHub issues, quick captures and unfiled
 * conversations. Each row says where it came from and why it's here, with
 * File/Accept, Dismiss and Open. Deterministic: nothing is triaged by a model.
 */
export function CaptureForm({
  onDone,
  autoFocus,
  inline,
  initialText,
  askable,
}: {
  onDone?: () => void;
  autoFocus?: boolean;
  /** one compact row (the inbox) */
  inline?: boolean;
  /** prefilled (the share sheet) */
  initialText?: string;
  /** offer "Ask Hermes instead" (needs hermes.chat) */
  askable?: boolean;
}) {
  const [text, setText] = useState(initialText ?? "");
  const save = useWorkMutation(() => api.post("/api/work/inbox", { text }), {
    ok: "Captured to the inbox",
    onSuccess: () => {
      setText("");
      onDone?.();
    },
  });
  if (inline)
    return (
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) save.mutate(undefined);
        }}
      >
        <div className="min-w-0 flex-1 basis-64">
          <label htmlFor="capture-text" className="wk-label mb-1 block">
            Capture to inbox
          </label>
          <textarea
            id="capture-text"
            aria-describedby="capture-text-hint"
            rows={1}
            className={`${inputCls} min-h-11 resize-y text-base sm:min-h-10`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) {
                e.preventDefault();
                save.mutate(undefined);
              }
            }}
            placeholder="Something to look at later…"
          />
          <p id="capture-text-hint" className="sr-only">
            First line becomes the title. File it later.
          </p>
        </div>
        <Button type="submit" size="sm" variant="primary" disabled={!text.trim()} busy={save.isPending}>
          Capture
        </Button>
      </form>
    );
  return <CaptureSheet onDone={() => onDone?.()} autoFocus={autoFocus} initial={initialText ? { text: initialText } : undefined} askable={askable} />;
}

/** The capture sheet (dock, palette, share target): Inbox by default, "Ask Hermes" as the alternative. */
export function CaptureDialog({ onClose, initialText }: { onClose: () => void; initialText?: string }) {
  const canChat = useAccess().can("hermes.chat");
  return (
    <Dialog open onClose={onClose} title="Capture" description="Goes to your Inbox. Nothing is sent anywhere unless you ask Hermes.">
      <CaptureForm onDone={onClose} autoFocus initialText={initialText} askable={canChat} />
    </Dialog>
  );
}

const TWO_PANE = "(min-width: 640px)";
const subscribeTwoPane = (cb: () => void) => {
  const m = window.matchMedia(TWO_PANE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
/** >=640: list + preview. Rendered conditionally (not CSS-hidden) so row and preview actions never both exist. */
function useTwoPane() {
  return useSyncExternalStore(
    subscribeTwoPane,
    () => window.matchMedia(TWO_PANE).matches,
    () => false,
  );
}

const SOURCE: Record<InboxEntry["source"], string> = { github_issue: "GitHub issue", capture: "Capture" };

export function InboxView({ items, onOpenItem }: { items: WorkItem[]; onOpenItem: (id: string) => void }) {
  const q = useInbox();
  const canChat = useAccess().can("hermes.chat");
  const [accepting, setAccepting] = useState<InboxEntry | null>(null);
  const dismiss = useWorkMutation((id: string) => api.post(`/api/work/inbox/${encodeURIComponent(id)}/dismiss`), { ok: "Dismissed" });
  const entries = q.data?.items ?? [];
  // Two-pane triage (>=640): the list selects, the preview acts. Keys: j/k or arrows move, Enter files, M chooses, E dismisses.
  const twoPane = useTwoPane();
  const [picked, setPicked] = useState<string | null>(null);
  const sel = entries.find((e) => e.id === picked) ?? entries[0] ?? null;
  const listRef = useRef<HTMLUListElement>(null);
  const fileHere = useWorkMutation(
    (e: InboxEntry) => api.post<{ item: WorkItem }>(`/api/work/inbox/${encodeURIComponent(e.id)}/accept`, { parentId: null, useSuggestion: true }),
    { ok: "Filed", onSuccess: (r) => onOpenItem(r.item.id) },
  );
  const primary = (e: InboxEntry) => (e.capture?.suggestion ? fileHere.mutate(e) : setAccepting(e));
  const move = (d: number) => {
    if (!entries.length) return;
    const i = Math.max(
      0,
      entries.findIndex((e) => e.id === sel?.id),
    );
    const next = entries[Math.min(entries.length - 1, Math.max(0, i + d))];
    setPicked(next.id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-inbox-pick="${CSS.escape(next.id)}"]`)?.focus();
  };
  const sectionRef = useRef<HTMLElement>(null);
  const keys = useRef<(ev: globalThis.KeyboardEvent) => void>(() => {});
  // Document-level so triage keeps working after the focused row is filed or dismissed (focus falls to <body>).
  useEffect(() => {
    keys.current = (ev) => {
      const t = ev.target as HTMLElement;
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey || !twoPane || !sel) return;
      if (t !== document.body && !sectionRef.current?.contains(t)) return;
      if (t.closest("input, textarea, select, [contenteditable], [role=menu], [role=dialog]")) return;
      const k = ev.key.toLowerCase();
      if (k === "j" || k === "arrowdown") move(1);
      else if (k === "k" || k === "arrowup") move(-1);
      else if (k === "enter" && (t.dataset.inboxPick || t === document.body)) primary(sel);
      else if (k === "m") setAccepting(sel);
      else if (k === "e") dismiss.mutate(sel.id);
      else return;
      ev.preventDefault();
    };
  });
  useEffect(() => {
    const on = (ev: globalThis.KeyboardEvent) => keys.current(ev);
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);
  return (
    <section ref={sectionRef} aria-labelledby="inbox-title" className="space-y-3" data-testid="work-inbox">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="wk-eyebrow">Triage</p>
          <h2 id="inbox-title" className="text-xl leading-tight font-semibold tracking-tight">
            Inbox
          </h2>
        </div>
        {q.data ? <span className="text-[13px] text-muted tabular-nums">{q.data.count} waiting</span> : null}
      </div>
      <div className="wk-card px-3 py-2.5">
        <CaptureForm inline />
      </div>
      <div className="min-w-0 gap-3 sm:grid sm:grid-cols-[minmax(0,330px)_minmax(0,1fr)] lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <section aria-labelledby="inbox-items" className="wk-card min-w-0 self-start overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <h3 id="inbox-items" className="wk-label">
              Assigned issues and captures
            </h3>
            {entries.length ? <span className="text-xs text-muted tabular-nums">{entries.length}</span> : null}
          </div>
          {q.isPending ? (
            <div className="p-3">
              <Spinner label="Loading inbox…" />
            </div>
          ) : null}
          {q.error ? (
            <div className="p-3">
              <ErrorNote error={q.error} retry={() => q.refetch()} />
            </div>
          ) : null}
          {q.data && !entries.length ? (
            <p className="px-3 py-2.5 text-[13px] text-muted">Nothing waiting. Issues assigned to you on GitHub land here.</p>
          ) : null}
          <ul className="wk-rows" ref={listRef}>
            {entries.map((e) => (
              <li
                key={e.id}
                className={cx("wk-row-hover flex items-start gap-x-2.5 px-3 py-2", sel?.id === e.id && "sm:bg-surface-2")}
                data-inbox-entry={e.id}
                data-selected={sel?.id === e.id ? "" : undefined}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    "mt-0.5 inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md font-mono text-[10px] font-bold",
                    e.source === "github_issue" ? "bg-text text-bg" : "bg-surface-2 text-muted ring-1 ring-line",
                  )}
                >
                  {e.source === "github_issue" ? "GH" : "CA"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] leading-snug font-semibold break-words">
                    {twoPane ? (
                      <button
                        type="button"
                        data-inbox-pick={e.id}
                        aria-current={sel?.id === e.id ? "true" : undefined}
                        className="text-left hover:underline focus-visible:underline"
                        onClick={() => setPicked(e.id)}
                        onFocus={() => setPicked(e.id)}
                      >
                        {e.title}
                      </button>
                    ) : (
                      e.title
                    )}
                  </p>
                  {e.note ? <p className="text-[13px] break-words whitespace-pre-wrap text-muted sm:line-clamp-1">{e.note}</p> : null}
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                    <span className="font-medium text-text/80">{SOURCE[e.source]}</span>
                    {e.repo ? (
                      <span className="font-mono">
                        {e.repo}#{e.number}
                      </span>
                    ) : null}
                    <span>{fmtWhen(e.createdAt)}</span>
                    {twoPane ? (
                      e.capture?.suggestion ? (
                        <span className="truncate text-accent">→ {e.capture.suggestion.title}</span>
                      ) : null
                    ) : (
                      <span>Why: {e.reason}</span>
                    )}
                  </p>
                  {e.capture && !twoPane ? <CaptureExtras entry={e} onAccepted={onOpenItem} onChoose={() => setAccepting(e)} /> : null}
                </div>
                {/* Phones: one visible action (File/Accept) + ⋯ (Dismiss). >=640 the preview pane holds the actions. */}
                {twoPane ? null : (
                  <div className="flex shrink-0 items-center gap-0.5">
                    {e.url ? (
                      <a
                        href={e.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="tap inline-flex min-h-11 items-center px-2 text-[13px] text-accent hover:underline sm:min-h-9"
                      >
                        Open<span className="sr-only">: {e.title} on GitHub (opens in a new tab)</span>
                      </a>
                    ) : null}
                    {e.capture?.suggestion ? (
                      // The suggestion chip is the row's 1-tap action; this picks somewhere else.
                      <Button size="sm" variant="ghost" onClick={() => setAccepting(e)} aria-label={`Choose where to file: ${e.title}`}>
                        Choose…
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => setAccepting(e)} aria-label={`${e.source === "github_issue" ? "Accept" : "File"}: ${e.title}`}>
                        {e.source === "github_issue" ? "Accept…" : "File…"}
                      </Button>
                    )}
                    {e.capture ? (
                      <CaptureRowMenu entry={e} label={`More for ${e.title}`} onDismiss={() => dismiss.mutate(e.id)} />
                    ) : (
                      <OverflowMenu label={`More for ${e.title}`} items={[{ label: "Dismiss", onSelect: () => dismiss.mutate(e.id), danger: true }]} />
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
        {twoPane && sel ? (
          <InboxPreview
            entry={sel}
            busy={fileHere.isPending}
            onPrimary={() => primary(sel)}
            onChoose={() => setAccepting(sel)}
            onDismiss={() => dismiss.mutate(sel.id)}
            onOpenItem={onOpenItem}
          />
        ) : null}
      </div>
      {canChat ? <UnfiledPanel items={items.filter((i) => !i.archived)} dismissable /> : null}
      {accepting ? (
        <AcceptDialog
          entry={accepting}
          items={items}
          onClose={() => setAccepting(null)}
          onAccepted={(id) => {
            setAccepting(null);
            onOpenItem(id);
          }}
        />
      ) : null}
    </section>
  );
}

/** >=640 preview: the entry, the AI suggestion block and the triage actions (one primary). */
function InboxPreview({
  entry: e,
  busy,
  onPrimary,
  onChoose,
  onDismiss,
  onOpenItem,
}: {
  entry: InboxEntry;
  busy: boolean;
  onPrimary: () => void;
  onChoose: () => void;
  onDismiss: () => void;
  onOpenItem: (id: string) => void;
}) {
  const s = e.capture?.suggestion;
  const kbd = "ml-1.5 rounded border border-line px-1 font-mono text-[10px] text-muted";
  return (
    <aside aria-label="Inbox preview" className="wk-card min-w-0 self-start p-4" data-testid="inbox-preview">
      <p className="wk-eyebrow">
        {SOURCE[e.source]}
        {e.repo ? (
          <span className="ml-1.5 font-mono normal-case">
            {e.repo}#{e.number}
          </span>
        ) : null}
      </p>
      <h3 className="mt-0.5 text-[15px] leading-snug font-semibold break-words">{e.title}</h3>
      <p data-dynamic className="mt-0.5 text-xs text-muted">
        {fmtWhen(e.createdAt)} · Why: {e.reason}
      </p>
      {e.note ? <p className="mt-2 text-[13px] break-words whitespace-pre-wrap">{e.note}</p> : null}
      {s ? (
        <div className="mt-3 rounded-[8px] border border-line bg-surface-2 px-3 py-2" data-testid="inbox-suggestion">
          <p className="wk-label">Suggested destination</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[13px]">
            <span className="font-medium">{s.path || s.title}</span>
            {s.confidence != null ? <Badge tone="accent">{Math.round(s.confidence * 100)}%</Badge> : null}
          </p>
          {s.reason ? <p className="mt-0.5 text-xs text-muted">{s.reason}</p> : null}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="primary" onClick={onPrimary} busy={busy} aria-keyshortcuts="Enter">
          {s ? "File here" : e.source === "github_issue" ? "Accept…" : "File…"}
          <kbd className={cx(kbd, "border-white/40 text-current")}>Enter</kbd>
        </Button>
        {s ? (
          <Button size="sm" onClick={onChoose} aria-keyshortcuts="M">
            Choose…<kbd className={kbd}>M</kbd>
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onDismiss} aria-keyshortcuts="E">
          Dismiss<kbd className={kbd}>E</kbd>
        </Button>
        {e.url ? (
          <a
            href={e.url}
            target="_blank"
            rel="noreferrer noopener"
            className="tap inline-flex min-h-9 items-center px-2 text-[13px] text-accent hover:underline"
          >
            Open on GitHub<span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
        {e.capture ? <CaptureRowMenu entry={e} label={`More for ${e.title}`} onDismiss={onDismiss} /> : null}
      </div>
      {e.capture ? (
        <div className="mt-2 [&_[data-testid=file-under-suggestion]]:hidden">
          <CaptureExtras entry={e} onAccepted={onOpenItem} />
        </div>
      ) : null}
    </aside>
  );
}

function AcceptDialog({ entry, items, onClose, onAccepted }: { entry: InboxEntry; items: WorkItem[]; onClose: () => void; onAccepted: (id: string) => void }) {
  const misc = items.find((i) => i.builtIn);
  const [dest, setDest] = useState(misc?.id ?? "");
  const [title, setTitle] = useState(entry.title);
  const [role, setRole] = useState<"reference" | "implementation">("reference");
  const accept = useWorkMutation(
    () =>
      api.post<{ item: WorkItem }>(`/api/work/inbox/${encodeURIComponent(entry.id)}/accept`, {
        parentId: dest && dest !== misc?.id ? dest : null,
        title,
        ...(entry.source === "github_issue" ? { role } : {}),
      }),
    { ok: "Filed", onSuccess: (r) => onAccepted(r.item.id) },
  );
  const options = itemPaths(items.filter((i) => !i.archived && i.kind !== "note"));
  return (
    <Dialog
      open
      onClose={onClose}
      title={entry.source === "github_issue" ? "Accept into Work" : "File capture"}
      description={entry.source === "github_issue" ? "Creates a thread linked to the issue. Nothing changes on GitHub." : "Creates a thread from your capture."}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="accept-form" busy={accept.isPending}>
            {entry.source === "github_issue" ? "Accept" : "File"}
          </Button>
        </>
      }
    >
      <form
        id="accept-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          accept.mutate(undefined);
        }}
      >
        <Field id="acc-title" label="Title">
          <input id="acc-title" data-autofocus required className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field id="acc-dest" label="File under">
          <select id="acc-dest" className={inputCls} value={dest} onChange={(e) => setDest(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        {entry.source === "github_issue" ? (
          <Field id="acc-role" label="The issue is">
            <select id="acc-role" className={inputCls} value={role} onChange={(e) => setRole(e.target.value as "reference" | "implementation")}>
              <option value="reference">Reference</option>
              <option value="implementation">Implementation</option>
            </select>
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}
