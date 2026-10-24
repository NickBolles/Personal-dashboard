"use client";

import { useState } from "react";
import { api } from "@/lib/client/api";
import { Badge, Button, Card, Dialog, ErrorNote, Field, Spinner, inputCls } from "@/components/ui";
import { useAccess } from "@/components/access";
import { useWorkMutation } from "@/components/work/common";
import { UnfiledPanel, fmtWhen, itemPaths } from "@/components/work/conversations";
import { useInbox } from "@/components/work/today";
import type { InboxEntry, WorkItem } from "@/lib/work";

/**
 * The Work inbox: assigned GitHub issues, quick captures and unfiled
 * conversations. Each row says where it came from and why it's here, with
 * File/Accept, Dismiss and Open. Deterministic: nothing is triaged by a model.
 */
export function CaptureForm({ onDone, autoFocus }: { onDone?: () => void; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const save = useWorkMutation(() => api.post("/api/work/inbox", { text }), {
    ok: "Captured to the inbox",
    onSuccess: () => {
      setText("");
      onDone?.();
    },
  });
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) save.mutate(undefined);
      }}
    >
      <Field id="capture-text" label="Capture to inbox" hint="First line becomes the title. File it later.">
        <textarea
          id="capture-text"
          data-autofocus={autoFocus || undefined}
          className={`${inputCls} min-h-20 text-base`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Something to look at later…"
        />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!text.trim()} busy={save.isPending}>
          Capture
        </Button>
      </div>
    </form>
  );
}

export function CaptureDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="Capture" description="Goes to the Work inbox. Nothing is sent anywhere.">
      <CaptureForm onDone={onClose} autoFocus />
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
    <section aria-labelledby="inbox-title" className="space-y-4" data-testid="work-inbox">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="inbox-title" className="text-xl font-semibold">
          Inbox
        </h2>
        {q.data ? <span className="text-sm text-muted">{q.data.count} waiting</span> : null}
      </div>
      <Card className="p-3">
        <CaptureForm />
      </Card>
      <Card as="section" aria-labelledby="inbox-items" className="min-w-0 p-3">
        <h3 id="inbox-items" className="mb-2 font-semibold">
          Assigned issues and captures
        </h3>
        {q.isPending ? <Spinner label="Loading inbox…" /> : null}
        {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
        {q.data && !entries.length ? <p className="text-sm text-muted">Nothing waiting. Issues assigned to you on GitHub land here.</p> : null}
        <ul className="space-y-3">
          {entries.map((e) => (
            <li key={e.id} className="rounded-lg border border-line p-3" data-inbox-entry={e.id}>
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge tone={e.source === "github_issue" ? "accent" : "neutral"}>{SOURCE[e.source]}</Badge>
                {e.repo ? (
                  <span>
                    {e.repo}#{e.number}
                  </span>
                ) : null}
                <span>{fmtWhen(e.createdAt)}</span>
              </p>
              <p className="mt-1 font-medium break-words">{e.title}</p>
              {e.note ? <p className="text-sm break-words whitespace-pre-wrap text-muted">{e.note}</p> : null}
              <p className="text-xs text-muted">Why: {e.reason}</p>
              <div className="mt-2 flex flex-wrap gap-2">
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
                    className="tap inline-flex min-h-11 items-center px-2 text-sm text-accent underline"
                  >
                    Open<span className="sr-only">: {e.title} on GitHub (opens in a new tab)</span>
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>
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
