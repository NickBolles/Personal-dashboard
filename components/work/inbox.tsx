"use client";

import { useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Dialog, ErrorNote, Field, Spinner, cx, inputCls } from "@/components/ui";
import { useAccess } from "@/components/access";
import { useWorkMutation } from "@/components/work/common";
import { UnfiledPanel, fmtWhen, itemPaths } from "@/components/work/conversations";
import { useInbox } from "@/components/work/today";
import { CaptureSheet } from "@/components/capture/CaptureSheet";
import { CaptureExtras } from "@/components/capture/CaptureExtras";
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
            className={`${inputCls} min-h-11 resize-y text-base`}
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

const SOURCE: Record<InboxEntry["source"], string> = { github_issue: "GitHub issue", capture: "Capture" };

export function InboxView({ items, onOpenItem }: { items: WorkItem[]; onOpenItem: (id: string) => void }) {
  const q = useInbox();
  const canChat = useAccess().can("hermes.chat");
  const [accepting, setAccepting] = useState<InboxEntry | null>(null);
  const dismiss = useWorkMutation((id: string) => api.post(`/api/work/inbox/${encodeURIComponent(id)}/dismiss`), { ok: "Dismissed" });
  const entries = q.data?.items ?? [];
  return (
    <section aria-labelledby="inbox-title" className="space-y-3" data-testid="work-inbox">
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
      <section aria-labelledby="inbox-items" className="wk-card min-w-0 overflow-hidden">
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
        {q.data && !entries.length ? <p className="px-3 py-2.5 text-[13px] text-muted">Nothing waiting. Issues assigned to you on GitHub land here.</p> : null}
        <ul className="wk-rows">
          {entries.map((e) => (
            <li key={e.id} className="wk-row-hover flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5" data-inbox-entry={e.id}>
              <span
                aria-hidden="true"
                className={cx(
                  "mt-0.5 inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md font-mono text-[10px] font-bold",
                  e.source === "github_issue" ? "bg-text text-bg" : "bg-surface-2 text-muted ring-1 ring-line",
                )}
              >
                {e.source === "github_issue" ? "GH" : "CA"}
              </span>
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-[14px] leading-snug font-semibold break-words">{e.title}</p>
                {e.note ? <p className="text-[13px] break-words whitespace-pre-wrap text-muted">{e.note}</p> : null}
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                  <span className="font-medium text-text/80">{SOURCE[e.source]}</span>
                  {e.repo ? (
                    <span className="font-mono">
                      {e.repo}#{e.number}
                    </span>
                  ) : null}
                  <span>{fmtWhen(e.createdAt)}</span>
                  <span>Why: {e.reason}</span>
                </p>
                {e.capture ? <CaptureExtras entry={e} onAccepted={onOpenItem} /> : null}
              </div>
              <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setAccepting(e)}
                  aria-label={`${e.source === "github_issue" ? "Accept" : "File"}: ${e.title}`}
                >
                  {e.source === "github_issue" ? "Accept…" : "File…"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  busy={dismiss.isPending && dismiss.variables === e.id}
                  onClick={() => dismiss.mutate(e.id)}
                  aria-label={`Dismiss: ${e.title}`}
                >
                  Dismiss
                </Button>
                {e.url ? (
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="tap inline-flex min-h-11 items-center px-2 text-[13px] text-accent underline"
                  >
                    Open<span className="sr-only">: {e.title} on GitHub (opens in a new tab)</span>
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
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
