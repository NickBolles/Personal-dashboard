"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Field, OverflowMenu, PageHeader, Spinner, inputCls, useToast } from "@/components/ui";
import { useAccess } from "@/components/access";
import { WorkTree } from "@/components/work/WorkTree";
import { StatusBadge, fmtDate, useGithubAutoRefresh, useWorkMutation } from "@/components/work/common";
import { ContinueDialog } from "@/components/work/ContinueDialog";
import { UndoBar, type UndoOp } from "@/components/work/UndoBar";
import { ConversationLinkDialog, UnfiledPanel, fmtWhen, itemPaths, useConversations } from "@/components/work/conversations";
import {
  COMPARATORS,
  handoffMarkdown,
  STATUS_LABELS,
  WORK_KINDS,
  WORK_STATUSES,
  type Comparator,
  type DependencyRef,
  type LinkKind,
  type WorkDetail,
  type WorkItem,
  type WorkKind,
  type WorkLink,
  type WorkStatus,
  type WorkValidation,
} from "@/lib/work";

const KIND_LABEL: Record<WorkKind, string> = { area: "Area", project: "Project", thread: "Thread", investigation: "Investigation", note: "Note" };
const textareaCls = `${inputCls} min-h-24`;

function useItems(archived: boolean) {
  return useQuery({ queryKey: ["work", "items", archived], queryFn: () => api.get<{ items: WorkItem[] }>(`/api/work/items${archived ? "?archived=1" : ""}`) });
}

export function WorkView({ initialItem }: { initialItem?: string }) {
  const [archived, setArchived] = useState(false);
  const items = useItems(archived);
  const [selected, setSelected] = useState<string | null>(initialItem ?? null);
  const [newArea, setNewArea] = useState(false);
  const canChat = useAccess().can("hermes.chat");
  const [undo, setUndo] = useState<UndoOp | null>(null);
  const clearUndo = useCallback(() => setUndo(null), []);
  const onOp = useCallback((op: UndoOp | null | undefined) => {
    if (op) setUndo(op);
  }, []);
  const place = useWorkMutation(
    (v: { id: string; parentId: string | null; index: number }) =>
      api.post<{ item: WorkItem; op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(v.id)}/place`, { parentId: v.parentId, index: v.index }),
    { onSuccess: (r) => onOp(r.op) },
  );

  const select = (id: string) => {
    setSelected(id);
    const url = new URL(window.location.href);
    url.searchParams.set("item", id);
    window.history.replaceState(null, "", url);
  };

  const list = items.data?.items ?? [];
  const current = selected && list.some((i) => i.id === selected) ? selected : null;

  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
      <PageHeader
        title="Work"
        subtitle="Areas, projects and threads of AI-assisted work. Private to you."
        actions={
          <Button size="sm" variant="primary" onClick={() => setNewArea(true)}>
            New area
          </Button>
        }
      />
      {items.error ? <ErrorNote error={items.error} retry={() => items.refetch()} /> : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(260px,320px)_1fr]">
        <div className="min-w-0 space-y-4 self-start">
          <Card className="min-w-0 p-3 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">
            <h2 className="sr-only">Work tree</h2>
            {items.isPending ? (
              <Spinner label="Loading work…" />
            ) : (
              <WorkTree items={list} selected={current} onSelect={select} onPlace={(id, parentId, index) => place.mutate({ id, parentId, index })} />
            )}
            <label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
              Show archived
            </label>
          </Card>
          {canChat && items.data ? <UnfiledPanel items={list.filter((i) => !i.archived)} onFiled={select} /> : null}
        </div>
        <div className="min-w-0">
          {current ? (
            <ItemDetail key={current} id={current} items={list} onSelect={select} onOp={onOp} />
          ) : (
            <Empty title="Pick something from the tree">Or start a new area. Items without a home go to Miscellaneous.</Empty>
          )}
        </div>
      </div>
      <NewItemDialog open={newArea} onClose={() => setNewArea(false)} parent={null} onCreated={(i) => select(i.id)} />
      {undo ? <UndoBar key={undo.id} op={undo} onDone={clearUndo} /> : null}
    </div>
  );
}

function NewItemDialog({
  open,
  onClose,
  parent,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  parent: WorkItem | null;
  onCreated: (i: WorkItem) => void;
}) {
  const defaultKind: WorkKind = !parent ? "area" : parent.kind === "area" ? "project" : "thread";
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<WorkKind>(defaultKind);
  const [summary, setSummary] = useState("");
  const create = useWorkMutation(() => api.post<{ item: WorkItem }>("/api/work/items", { title, kind, summary, parentId: parent?.id ?? null }), {
    ok: "Created",
    onSuccess: (r) => {
      setTitle("");
      setSummary("");
      onClose();
      onCreated(r.item);
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={parent ? `New item in ${parent.title}` : "New area"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" form="new-item" type="submit" busy={create.isPending}>
            Create
          </Button>
        </>
      }
    >
      <form
        id="new-item"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(undefined);
        }}
      >
        <Field id="ni-title" label="Title">
          <input id="ni-title" data-autofocus required className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        {parent ? (
          <Field id="ni-kind" label="Kind">
            <select id="ni-kind" className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as WorkKind)}>
              {WORK_KINDS.filter((k) => k !== "area").map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field id="ni-summary" label="Summary (optional)">
          <textarea id="ni-summary" className={textareaCls} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

type DialogKind = null | "child" | "fork" | "split" | "move" | "packet" | "settle" | "reopen" | "continue" | LinkKind;

type OnOp = (op: UndoOp | null | undefined) => void;

function ItemDetail({ id, items, onSelect, onOp }: { id: string; items: WorkItem[]; onSelect: (id: string) => void; onOp: OnOp }) {
  const q = useQuery({ queryKey: ["work", "item", id], queryFn: () => api.get<WorkDetail>(`/api/work/items/${encodeURIComponent(id)}`) });
  const [tab, setTab] = useState<"overview" | "activity" | "children">("overview");
  const [dialog, setDialog] = useState<DialogKind>(null);
  const patch = useWorkMutation((body: Record<string, unknown>) => api.patch<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(id)}`, body), {
    onSuccess: (r) => onOp(r.op),
    ok: "Saved",
  });
  const reorder = useWorkMutation(
    (direction: "up" | "down") => api.post<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(id)}/reorder`, { direction }),
    { onSuccess: (r) => onOp(r.op) },
  );
  const close = () => setDialog(null);
  // Conversations are Hermes/Claude chats: only offered to people who can chat (the API checks too).
  const canChat = useAccess().can("hermes.chat");
  useGithubAutoRefresh(!!q.data?.githubRefresh && q.data.links.some((l) => l.kind === "github_pr" || l.kind === "github_issue"), id);

  if (q.isPending) return <Spinner label="Loading…" />;
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const { item } = d;
  const isArea = item.parentId === null;
  const chat = d.links.find((l) => l.kind === "chat_session");

  return (
    <article aria-labelledby="work-item-title" className="space-y-4">
      <Card className="space-y-3">
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
            {d.breadcrumb.map((b) => (
              <li key={b.id} className="flex items-center gap-1">
                <button type="button" className="tap rounded px-1 hover:text-text hover:underline" onClick={() => onSelect(b.id)}>
                  {b.title}
                </button>
                <span aria-hidden="true">›</span>
              </li>
            ))}
            <li aria-current="page" className="px-1">
              {KIND_LABEL[item.kind]}
            </li>
          </ol>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="work-item-title" className="text-xl font-semibold break-words">
              {item.title}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <StatusBadge status={item.status} auto={item.settledKind === "auto"} />
              {item.archived ? <Badge>Archived</Badge> : null}
              {item.settledReason ? <span className="text-sm text-muted">{item.settledReason}</span> : null}
            </div>
          </div>
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <label htmlFor="work-status" className="block text-xs font-medium text-muted">
                Status
              </label>
              <select
                id="work-status"
                className={`${inputCls} min-h-11 py-1`}
                value={item.status}
                onChange={(e) => {
                  const to = e.target.value as WorkStatus;
                  if (to === "settled") setDialog("settle");
                  else if (to === "reopened") setDialog("reopen");
                  else patch.mutate({ status: to });
                }}
              >
                {WORK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <OverflowMenu
              label="More item actions"
              items={[
                { label: "Fork", onSelect: () => setDialog("fork"), disabled: isArea },
                { label: "Split into child", onSelect: () => setDialog("split") },
                { label: "Move…", onSelect: () => setDialog("move"), disabled: item.builtIn },
                { label: "Move up", onSelect: () => reorder.mutate("up") },
                { label: "Move down", onSelect: () => reorder.mutate("down") },
                {
                  label: item.archived ? "Unarchive" : "Archive",
                  onSelect: () => patch.mutate({ archived: !item.archived }),
                  disabled: item.builtIn,
                  danger: !item.archived,
                },
              ]}
            />
          </div>
        </div>
        <div className="rounded-[10px] bg-surface-2 p-3">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">Next action</p>
          <p className="mt-0.5 break-words">{item.nextAction || <span className="text-muted">Not set</span>}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={() => setDialog("packet")}>
            Start focused work
          </Button>
          <Button size="sm" onClick={() => setDialog("child")}>
            New child
          </Button>
          <Button size="sm" onClick={() => setDialog("github_pr")}>
            Link PR
          </Button>
          {canChat ? (
            <Button size="sm" onClick={() => setDialog("chat_session")}>
              Link conversation
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setDialog("url")}>
            Link URL
          </Button>
          {item.status === "settled" || item.status === "awaiting_validation" || d.validations.some((v) => v.status === "fail") ? (
            <Button size="sm" onClick={() => setDialog("reopen")}>
              Reopen
            </Button>
          ) : null}
        </div>
      </Card>

      <div role="tablist" aria-label="Item sections" className="flex gap-1">
        {(
          [
            ["overview", "Overview"],
            ["activity", "Activity"],
            ["children", `Children (${d.children.length})`],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`panel-${k}`}
            tabIndex={tab === k ? 0 : -1}
            onClick={() => setTab(k)}
            onKeyDown={(e) => {
              const keys = ["overview", "activity", "children"] as const;
              const i = keys.indexOf(k);
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                const n = keys[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3]!;
                setTab(n);
                document.getElementById(`tab-${n}`)?.focus();
              }
            }}
            className={`inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-medium ${tab === k ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="space-y-4">
        {tab === "overview" ? (
          <>
            <EditItem key={item.updatedAt} item={item} />
            <PacketCard d={d} onRevise={() => setDialog("packet")} onContinue={canChat ? () => setDialog("continue") : undefined} />
            <Validations d={d} onSettle={() => setDialog("settle")} onReopen={() => setDialog("reopen")} />
            <Dependencies d={d} items={items} onSelect={onSelect} />
            <Links d={d} canChat={canChat} />
          </>
        ) : tab === "activity" ? (
          <Activity d={d} onSelect={onSelect} />
        ) : (
          <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="font-semibold">Children</h3>
              <Button size="sm" onClick={() => setDialog("child")}>
                Add child
              </Button>
            </div>
            {d.children.length ? (
              <ul className="divide-y divide-line">
                {d.children.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <button type="button" className="tap min-w-0 text-left font-medium hover:underline" onClick={() => onSelect(c.id)}>
                      {c.title}
                    </button>
                    <StatusBadge status={c.status} auto={c.settledKind === "auto"} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No children yet.</p>
            )}
          </Card>
        )}
      </div>

      <NewItemDialog open={dialog === "child"} onClose={close} parent={item} onCreated={(i) => onSelect(i.id)} />
      <ForkDialog open={dialog === "fork"} onClose={close} item={item} chat={canChat ? chat : undefined} onCreated={onSelect} onOp={onOp} />
      <SplitDialog open={dialog === "split"} onClose={close} item={item} onCreated={onSelect} onOp={onOp} />
      <MoveDialog open={dialog === "move"} onClose={close} item={item} items={items} onOp={onOp} />
      {dialog === "packet" ? <PacketDialog open onClose={close} d={d} /> : null}
      {dialog === "continue" ? <ContinueDialog d={d} markdown={handoffMarkdown(d, window.location.origin)} onClose={close} /> : null}
      <SettleDialog open={dialog === "settle"} onClose={close} d={d} />
      <ReopenDialog open={dialog === "reopen"} onClose={close} item={item} onFollowUp={onSelect} />
      {dialog === "github_pr" || dialog === "url" ? <LinkDialog kind={dialog} onClose={close} item={item} /> : null}
      {dialog === "chat_session" ? (
        <ConversationLinkDialog
          item={item}
          onClose={close}
          linkedHere={new Set(d.links.filter((l) => l.kind === "chat_session").map((l) => l.targetId ?? ""))}
        />
      ) : null}
    </article>
  );
}

function EditItem({ item }: { item: WorkItem }) {
  const [f, setF] = useState({
    title: item.title,
    summary: item.summary,
    nextAction: item.nextAction,
    startDate: item.startDate ?? "",
    targetDate: item.targetDate ?? "",
  });
  const save = useWorkMutation(
    () => api.patch(`/api/work/items/${encodeURIComponent(item.id)}`, { ...f, startDate: f.startDate || null, targetDate: f.targetDate || null }),
    { ok: "Saved" },
  );
  const dirty =
    f.title !== item.title ||
    f.summary !== item.summary ||
    f.nextAction !== item.nextAction ||
    f.startDate !== (item.startDate ?? "") ||
    f.targetDate !== (item.targetDate ?? "");
  return (
    <Card>
      <h3 className="mb-3 font-semibold">Details</h3>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <Field id="wi-title" label="Title">
          <input id="wi-title" required className={inputCls} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field id="wi-summary" label="Summary">
          <textarea id="wi-summary" className={textareaCls} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />
        </Field>
        <Field id="wi-next" label="Next action">
          <input id="wi-next" className={inputCls} value={f.nextAction} onChange={(e) => setF({ ...f, nextAction: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="wi-start" label="Start date">
            <input id="wi-start" type="date" className={inputCls} value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
          </Field>
          <Field id="wi-target" label="Target date">
            <input id="wi-target" type="date" className={inputCls} value={f.targetDate} onChange={(e) => setF({ ...f, targetDate: e.target.value })} />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" size="sm" variant="primary" disabled={!dirty} busy={save.isPending}>
            Save details
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PacketCard({ d, onRevise, onContinue }: { d: WorkDetail; onRevise: () => void; onContinue?: () => void }) {
  const { toast } = useToast();
  // Client-only: this card renders after the detail query resolves in the browser.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const p = d.packets[0];
  const md = handoffMarkdown(d, origin);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(md);
      toast("Handoff copied", "ok");
    } catch {
      toast("Couldn't copy. Use the preview below.", "warn");
    }
  };
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{p ? `Work packet v${p.version}` : "Work packet"}</h3>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={copy}>
            Copy handoff
          </Button>
          {onContinue ? (
            <Button size="sm" onClick={onContinue}>
              Continue in new conversation
            </Button>
          ) : null}
          {p ? (
            <Button size="sm" onClick={onRevise}>
              New revision
            </Button>
          ) : null}
        </div>
      </div>
      {p ? (
        <>
          <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
            <PacketRow label="Objective" value={p.objective} />
            <PacketRow label="In scope" value={p.inScope} />
            <PacketRow label="Out of scope" value={p.outOfScope} />
            <PacketRow label="Acceptance criteria" value={p.acceptanceCriteria} />
            <PacketRow label="Decisions" value={p.decisions} />
            <PacketRow label="Open questions" value={p.openQuestions} />
            <PacketRow label="Context" value={p.context} />
            <PacketRow label="Validation" value={p.validationRequired ? "Required before settling" : `Not required: ${p.noValidationReason ?? ""}`} />
          </dl>
          <p className="mt-2 text-xs text-muted">Created {fmtDate(p.createdAt)}. Packets are immutable; changes make a new version.</p>
          {d.packets.length > 1 ? (
            <details className="mt-2 text-sm">
              <summary className="tap cursor-pointer text-accent">Version history ({d.packets.length})</summary>
              <ol className="mt-2 space-y-2">
                {d.packets.map((v) => (
                  <li key={v.id} className="rounded-lg bg-surface-2 p-2">
                    <span className="font-medium">v{v.version}</span> · {fmtDate(v.createdAt)} · <span className="break-words">{v.objective}</span>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted">No packet yet. Start focused work to write one.</p>
      )}
      <details className="mt-2 text-sm">
        <summary className="tap cursor-pointer text-accent">Preview handoff</summary>
        <pre data-testid="handoff-preview" className="mt-2 max-h-80 overflow-auto rounded-lg bg-surface-2 p-3 text-xs break-words whitespace-pre-wrap">
          {md}
        </pre>
      </details>
    </Card>
  );
}

function PacketRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <>
      <dt className="font-medium text-muted">{label}</dt>
      <dd className="break-words whitespace-pre-wrap">{value}</dd>
    </>
  );
}

function Validations({ d, onSettle, onReopen }: { d: WorkDetail; onSettle: () => void; onReopen: () => void }) {
  const [adding, setAdding] = useState(false);
  const failed = d.validations.some((v) => v.status === "fail");
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Validation</h3>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            Add validation
          </Button>
          {d.item.status !== "settled" ? (
            <Button size="sm" variant="primary" disabled={!d.settle.allowed} onClick={onSettle} aria-describedby={d.settle.allowed ? undefined : "settle-why"}>
              Settle
            </Button>
          ) : null}
        </div>
      </div>
      {!d.settle.allowed && d.item.status !== "settled" ? (
        <p id="settle-why" className="mb-2 text-sm text-muted">
          {d.settle.reason}
        </p>
      ) : null}
      {failed && d.item.status !== "reopened" ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-danger-soft p-2 text-sm text-danger">
          <span>A validation failed.</span>
          <Button size="sm" onClick={onReopen}>
            Reopen with failed evidence
          </Button>
        </div>
      ) : null}
      {adding ? <AddValidation itemId={d.item.id} onDone={() => setAdding(false)} /> : null}
      {d.validations.length ? (
        <ul className="space-y-3">
          {d.validations.map((v) => (
            <ValidationRow key={v.id} v={v} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No validations. A merged PR is not proof the outcome was achieved: declare what you&apos;ll measure.</p>
      )}
    </Card>
  );
}

function AddValidation({ itemId, onDone }: { itemId: string; onDone: () => void }) {
  const [f, setF] = useState({ metric: "", comparator: "<=" as Comparator, threshold: "", unit: "", baseline: "", dueDate: "" });
  const add = useWorkMutation(
    () =>
      api.post(`/api/work/items/${encodeURIComponent(itemId)}/validations`, {
        metric: f.metric,
        comparator: f.comparator,
        threshold: Number(f.threshold),
        unit: f.unit,
        baseline: f.baseline === "" ? null : Number(f.baseline),
        dueDate: f.dueDate || null,
      }),
    { ok: "Validation added", onSuccess: onDone },
  );
  return (
    <form
      className="mb-3 grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate(undefined);
      }}
    >
      <Field id="va-metric" label="Metric">
        <input
          id="va-metric"
          required
          className={inputCls}
          value={f.metric}
          onChange={(e) => setF({ ...f, metric: e.target.value })}
          placeholder="p95 hydration"
        />
      </Field>
      <div className="grid grid-cols-[6rem_1fr] gap-2">
        <Field id="va-cmp" label="Comparator">
          <select id="va-cmp" className={inputCls} value={f.comparator} onChange={(e) => setF({ ...f, comparator: e.target.value as Comparator })}>
            {COMPARATORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field id="va-threshold" label="Threshold">
          <input
            id="va-threshold"
            required
            type="number"
            step="any"
            className={inputCls}
            value={f.threshold}
            onChange={(e) => setF({ ...f, threshold: e.target.value })}
          />
        </Field>
      </div>
      <Field id="va-unit" label="Unit">
        <input id="va-unit" className={inputCls} value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="ms" />
      </Field>
      <Field id="va-baseline" label="Baseline (optional)">
        <input id="va-baseline" type="number" step="any" className={inputCls} value={f.baseline} onChange={(e) => setF({ ...f, baseline: e.target.value })} />
      </Field>
      <Field id="va-due" label="Due date (optional)">
        <input id="va-due" type="date" className={inputCls} value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
      </Field>
      <div className="flex items-end justify-end gap-2">
        <Button type="button" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" busy={add.isPending}>
          Save validation
        </Button>
      </div>
    </form>
  );
}

const V_TONE = { pending: "neutral", pass: "ok", fail: "danger", waived: "warn" } as const;

function ValidationRow({ v }: { v: WorkValidation }) {
  const [observed, setObserved] = useState(v.observed?.toString() ?? "");
  const [evidence, setEvidence] = useState(v.evidenceUrl ?? "");
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState("");
  const url = `/api/work/validations/${encodeURIComponent(v.id)}`;
  const record = useWorkMutation(() => api.patch(url, { observed: observed === "" ? null : Number(observed), evidenceUrl: evidence || null }), {
    ok: "Evidence recorded",
  });
  const waive = useWorkMutation(() => api.patch(url, { waive: true, waiverReason: reason }), { ok: "Waived", onSuccess: () => setWaiving(false) });
  const remove = useWorkMutation(() => api.del(url), { ok: "Validation removed" });
  const label = `${v.metric} ${v.comparator} ${v.threshold}${v.unit ? ` ${v.unit}` : ""}`;
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium break-words">{label}</p>
        <Badge tone={V_TONE[v.status]}>{v.status === "pass" ? "Pass" : v.status === "fail" ? "Fail" : v.status === "waived" ? "Waived" : "Pending"}</Badge>
      </div>
      <p className="mt-1 text-sm text-muted">
        {v.baseline !== null ? `Baseline ${v.baseline}${v.unit ? ` ${v.unit}` : ""} · ` : ""}
        {v.observed !== null ? `Observed ${v.observed}${v.unit ? ` ${v.unit}` : ""}` : "Not measured yet"}
        {v.dueDate ? ` · due ${fmtDate(v.dueDate)}` : ""}
        {v.waiverReason ? ` · waived: ${v.waiverReason}` : ""}
      </p>
      {v.evidenceUrl ? (
        <a href={v.evidenceUrl} target="_blank" rel="noreferrer noopener" className="text-sm text-accent underline break-all">
          Evidence<span className="sr-only"> for {v.metric} (opens in a new tab)</span>
        </a>
      ) : null}
      <form
        className="mt-2 grid gap-2 sm:grid-cols-[1fr_2fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          record.mutate(undefined);
        }}
      >
        <div>
          <label htmlFor={`obs-${v.id}`} className="block text-xs font-medium text-muted">
            Observed {v.unit ? `(${v.unit})` : ""}
          </label>
          <input
            id={`obs-${v.id}`}
            aria-label={`Observed value for ${v.metric}`}
            type="number"
            step="any"
            className={inputCls}
            value={observed}
            onChange={(e) => setObserved(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor={`ev-${v.id}`} className="block text-xs font-medium text-muted">
            Evidence link
          </label>
          <input id={`ev-${v.id}`} type="url" className={inputCls} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="https://…" />
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit" size="sm" busy={record.isPending} aria-label={`Record ${v.metric}`}>
            Record
          </Button>
          <OverflowMenu
            label={`More for ${v.metric}`}
            items={[
              { label: "Waive…", onSelect: () => setWaiving(true) },
              { label: "Remove", onSelect: () => remove.mutate(undefined), danger: true },
            ]}
          />
        </div>
      </form>
      <Dialog
        open={waiving}
        onClose={() => setWaiving(false)}
        title={`Waive ${v.metric}`}
        description="Waivers are recorded with your reason."
        footer={
          <>
            <Button onClick={() => setWaiving(false)}>Cancel</Button>
            <Button variant="primary" disabled={!reason.trim()} busy={waive.isPending} onClick={() => waive.mutate(undefined)}>
              Waive
            </Button>
          </>
        }
      >
        <Field id={`wv-${v.id}`} label="Reason">
          <textarea id={`wv-${v.id}`} data-autofocus className={textareaCls} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </li>
  );
}

function Dependencies({ d, items, onSelect }: { d: WorkDetail; items: WorkItem[]; onSelect: (id: string) => void }) {
  const [dest, setDest] = useState("");
  const add = useWorkMutation(() => api.post(`/api/work/items/${encodeURIComponent(d.item.id)}/dependencies`, { dependsOnId: dest }), {
    ok: "Dependency added",
    onSuccess: () => setDest(""),
  });
  const remove = useWorkMutation((depId: string) => api.del(`/api/work/dependencies/${encodeURIComponent(depId)}`), { ok: "Dependency removed" });
  const taken = new Set([d.item.id, ...d.blockedBy.map((b) => b.id)]);
  const options = itemPaths(
    items.filter((i) => i.parentId !== null && !i.archived),
    taken,
  );
  const openBlockers = d.blockedBy.filter((b) => b.open).length;
  const row = (r: DependencyRef, label: string) => (
    <li key={r.dependencyId} className="flex flex-wrap items-center justify-between gap-2 py-1">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <button type="button" className="tap min-w-0 text-left break-words text-accent underline" onClick={() => onSelect(r.id)}>
          {r.title}
        </button>
        <StatusBadge status={r.status} />
      </span>
      <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.dependencyId)} aria-label={`${label} ${r.title}: remove`}>
        Remove
      </Button>
    </li>
  );
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Dependencies</h3>
        {openBlockers ? <Badge tone="warn">Blocked by {openBlockers}</Badge> : null}
      </div>
      <h4 className="text-xs font-medium tracking-wide text-muted uppercase">Blocked by</h4>
      {d.blockedBy.length ? (
        <ul className="divide-y divide-line">{d.blockedBy.map((r) => row(r, "Blocked by"))}</ul>
      ) : (
        <p className="text-sm text-muted">Nothing. Add work this has to wait for.</p>
      )}
      {d.blocking.length ? (
        <>
          <h4 className="mt-3 text-xs font-medium tracking-wide text-muted uppercase">Blocks</h4>
          <ul className="divide-y divide-line">{d.blocking.map((r) => row(r, "Blocks"))}</ul>
        </>
      ) : null}
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dest) add.mutate(undefined);
        }}
      >
        <div className="min-w-0 flex-1">
          <Field id="dep-add" label="Depends on">
            <select id="dep-add" className={inputCls} value={dest} onChange={(e) => setDest(e.target.value)}>
              <option value="">Choose…</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button type="submit" size="sm" disabled={!dest} busy={add.isPending}>
          Add dependency
        </Button>
      </form>
    </Card>
  );
}

function linkLabel(l: WorkLink) {
  return l.kind === "chat_session" ? "Conversation" : l.kind === "github_pr" ? "Pull request" : l.kind === "github_issue" ? "Issue" : "Link";
}

function Links({ d, canChat }: { d: WorkDetail; canChat: boolean }) {
  const hasChat = d.links.some((l) => l.kind === "chat_session");
  const convs = useConversations(canChat && hasChat);
  const activity = new Map((convs.data?.conversations ?? []).map((c) => [c.id, c.lastActiveAt]));
  return (
    <Card>
      <h3 className="mb-2 font-semibold">Links</h3>
      {d.links.length ? (
        <ul className="space-y-2">
          {d.links.map((l) => (
            <LinkRow key={l.id} l={l} refresh={d.githubRefresh} lastActive={l.kind === "chat_session" ? activity.get(l.targetId ?? "") : undefined} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Link the conversation this came from, the PR that implements it, or evidence.</p>
      )}
      {!d.githubRefresh && d.links.some((l) => l.kind === "github_pr" || l.kind === "github_issue") ? (
        <p className="mt-2 text-xs text-muted">
          Set JARVIS_GITHUB_TOKEN on the server to refresh PR state from GitHub (read-only). Until then, mark it yourself.
        </p>
      ) : d.githubRefresh && d.links.some((l) => l.kind === "github_pr" || l.kind === "github_issue") ? (
        <p className="mt-2 text-xs text-muted">PR and issue states refresh from GitHub (read-only) when you open this item, at most every 5 minutes.</p>
      ) : null}
    </Card>
  );
}

function LinkRow({ l, refresh, lastActive }: { l: WorkLink; refresh: boolean; lastActive?: string | null }) {
  const url = `/api/work/links/${encodeURIComponent(l.id)}`;
  const state = useWorkMutation((externalState: "open" | "merged" | "closed") => api.patch(url, { externalState }), {
    ok: l.kind === "github_issue" ? "Issue state updated" : "PR state updated",
  });
  const remove = useWorkMutation(() => api.del(url), { ok: "Link removed" });
  const pull = useWorkMutation(() => api.post(`${url}/refresh`), { ok: "Refreshed from GitHub" });
  const name = l.title || l.targetId || l.url || "";
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted">
            {linkLabel(l)} · {l.role}
            {l.lineage === "handoff_from" ? " · started from the handoff" : ""}
          </p>
          <p className="font-medium break-words">{name}</p>
          {(l.kind === "github_pr" || l.kind === "github_issue") && l.checkedAt ? (
            <p className={`text-xs ${l.checkError ? "text-danger" : "text-muted"}`}>
              {l.checkError ? `GitHub check failed ${fmtWhen(l.checkedAt)}: ${l.checkError}` : `Checked on GitHub ${fmtWhen(l.checkedAt)}`}
            </p>
          ) : null}
          {l.kind === "chat_session" ? <p className="text-xs text-muted">Last activity {lastActive ? fmtWhen(lastActive) : "unknown"}</p> : null}
        </div>
        {l.externalState ? (
          <Badge tone={l.externalState === "merged" ? "ok" : l.externalState === "closed" ? "neutral" : "accent"}>{l.externalState}</Badge>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {l.kind === "chat_session" ? (
          <Link href={`/chat/${encodeURIComponent(l.targetId ?? "")}`} className="tap inline-flex items-center text-sm text-accent underline">
            Open conversation<span className="sr-only">: {name}</span>
          </Link>
        ) : l.url ? (
          <a href={l.url} target="_blank" rel="noreferrer noopener" className="tap inline-flex items-center text-sm text-accent underline">
            Open<span className="sr-only">: {name} (opens in a new tab)</span>
          </a>
        ) : null}
        {l.kind === "github_pr" && l.externalState !== "merged" ? (
          <Button size="sm" onClick={() => state.mutate("merged")} busy={state.isPending}>
            Mark merged
          </Button>
        ) : null}
        {l.kind === "github_pr" && l.externalState === "open" ? (
          <Button size="sm" onClick={() => state.mutate("closed")}>
            Mark closed
          </Button>
        ) : null}
        {l.kind === "github_issue" ? (
          <Button size="sm" onClick={() => state.mutate(l.externalState === "closed" ? "open" : "closed")} busy={state.isPending}>
            {l.externalState === "closed" ? "Mark open" : "Mark closed"}
          </Button>
        ) : null}
        {(l.kind === "github_pr" || l.kind === "github_issue") && refresh ? (
          <Button size="sm" onClick={() => pull.mutate(undefined)} busy={pull.isPending}>
            Refresh
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => remove.mutate(undefined)} aria-label={`Remove link ${name}`}>
          Remove
        </Button>
      </div>
    </li>
  );
}

function LinkDialog({ kind, onClose, item }: { kind: LinkKind; onClose: () => void; item: WorkItem }) {
  const [value, setValue] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState(kind === "github_pr" ? "implementation" : kind === "chat_session" ? "source" : "reference");
  const add = useWorkMutation(
    () =>
      api.post(`/api/work/items/${encodeURIComponent(item.id)}/links`, {
        kind,
        ...(kind === "chat_session" ? { targetId: value } : { url: value }),
        title: title || undefined,
        role,
      }),
    { ok: "Linked", onSuccess: onClose },
  );
  const heading = kind === "github_pr" ? "Link a pull request" : kind === "chat_session" ? "Link a conversation" : "Link a URL";
  const label = kind === "github_pr" ? "GitHub PR URL" : kind === "chat_session" ? "Conversation id or /chat link" : "URL";
  return (
    <Dialog
      open
      onClose={onClose}
      title={heading}
      description={kind === "github_pr" ? "Jarvis only reads PR state; it never writes to GitHub." : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="link-form" busy={add.isPending}>
            Add link
          </Button>
        </>
      }
    >
      <form
        id="link-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(undefined);
        }}
      >
        <Field id="lk-value" label={label}>
          <input
            id="lk-value"
            data-autofocus
            required
            className={inputCls}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={kind === "github_pr" ? "https://github.com/owner/repo/pull/123" : kind === "chat_session" ? "/chat/…" : "https://…"}
          />
        </Field>
        <Field id="lk-title" label="Title (optional)">
          <input id="lk-title" className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field id="lk-role" label="Role">
          <select id="lk-role" className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="source">Source</option>
            <option value="implementation">Implementation</option>
            <option value="evidence">Evidence</option>
            <option value="reference">Reference</option>
          </select>
        </Field>
      </form>
    </Dialog>
  );
}

function ForkDialog({
  open,
  onClose,
  item,
  chat,
  onCreated,
  onOp,
}: {
  open: boolean;
  onClose: () => void;
  item: WorkItem;
  chat?: WorkLink;
  onCreated: (id: string) => void;
  onOp: OnOp;
}) {
  const [title, setTitle] = useState(`${item.title} (fork)`);
  const fork = useWorkMutation(() => api.post<{ item: WorkItem; op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(item.id)}/fork`, { title }), {
    onSuccess: (r) => {
      onClose();
      onCreated(r.item.id);
      onOp(r.op);
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Fork ${item.title}`}
      description="Creates a sibling with the same summary, next action and source links."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={fork.isPending} onClick={() => fork.mutate(undefined)}>
            Fork
          </Button>
        </>
      }
    >
      <Field id="fk-title" label="Title">
        <input id="fk-title" data-autofocus className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      {chat ? (
        <p className="mt-3 text-sm">
          This item has a linked conversation.{" "}
          <Link href={`/chat/${encodeURIComponent(chat.targetId ?? "")}`} className="text-accent underline">
            Open conversation to fork there
          </Link>
          . Jarvis doesn&apos;t fork it automatically.
        </p>
      ) : null}
    </Dialog>
  );
}

function SplitDialog({
  open,
  onClose,
  item,
  onCreated,
  onOp,
}: {
  open: boolean;
  onClose: () => void;
  item: WorkItem;
  onCreated: (id: string) => void;
  onOp: OnOp;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const split = useWorkMutation(
    () => api.post<{ item: WorkItem; op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(item.id)}/split`, { title, summary }),
    {
      onSuccess: (r) => {
        onClose();
        onCreated(r.item.id);
        onOp(r.op);
      },
    },
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Split from ${item.title}`}
      description="A new child item; the source stays as it is."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="split-form" busy={split.isPending}>
            Split
          </Button>
        </>
      }
    >
      <form
        id="split-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          split.mutate(undefined);
        }}
      >
        <Field id="sp-title" label="Child title">
          <input id="sp-title" data-autofocus required className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field id="sp-summary" label="Summary excerpt">
          <textarea id="sp-summary" className={textareaCls} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}

function MoveDialog({ open, onClose, item, items, onOp }: { open: boolean; onClose: () => void; item: WorkItem; items: WorkItem[]; onOp: OnOp }) {
  const [dest, setDest] = useState("");
  // Exclude the item and its descendants (the server also refuses cycles).
  const banned = new Set<string>([item.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of items)
      if (i.parentId && banned.has(i.parentId) && !banned.has(i.id)) {
        banned.add(i.id);
        grew = true;
      }
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const path = (i: WorkItem) => {
    const parts = [i.title];
    for (let p = i.parentId ? byId.get(i.parentId) : undefined; p && parts.length < 8; p = p.parentId ? byId.get(p.parentId) : undefined)
      parts.unshift(p.title);
    return parts.join(" › ");
  };
  const options = items
    .filter((i) => !banned.has(i.id) && i.id !== item.parentId && i.kind !== "note")
    .map((i) => ({ id: i.id, label: path(i) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const move = useWorkMutation(
    () => api.post<{ op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(item.id)}/move`, { parentId: dest === "__top" ? null : dest }),
    {
      onSuccess: (r) => {
        onClose();
        onOp(r.op);
      },
    },
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Move ${item.title}`}
      description="Moving changes placement only; history and lineage are kept."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!dest} busy={move.isPending} onClick={() => move.mutate(undefined)}>
            Move here
          </Button>
        </>
      }
    >
      <Field id="mv-dest" label="Destination">
        <select id="mv-dest" data-autofocus className={inputCls} value={dest} onChange={(e) => setDest(e.target.value)}>
          <option value="">Choose…</option>
          {item.kind === "area" && item.parentId ? <option value="__top">Top level</option> : null}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    </Dialog>
  );
}

function PacketDialog({ open, onClose, d }: { open: boolean; onClose: () => void; d: WorkDetail }) {
  const prev = d.packets[0];
  const init = () => ({
    objective: prev?.objective ?? d.item.summary,
    inScope: prev?.inScope ?? "",
    outOfScope: prev?.outOfScope ?? "",
    acceptanceCriteria: prev?.acceptanceCriteria ?? "",
    decisions: prev?.decisions ?? "",
    openQuestions: prev?.openQuestions ?? "",
    context: prev?.context ?? "",
    nextAction: d.item.nextAction,
    status: (d.item.status === "ready" ? "ready" : "in_progress") as "ready" | "in_progress",
    validationRequired: prev?.validationRequired ?? true,
    noValidationReason: prev?.noValidationReason ?? "",
  });
  const [f, setF] = useState(init);
  const save = useWorkMutation(
    () =>
      api.post(`/api/work/items/${encodeURIComponent(d.item.id)}/packets`, {
        ...f,
        noValidationReason: f.validationRequired ? undefined : f.noValidationReason,
      }),
    { ok: prev ? `Packet v${prev.version + 1} saved` : "Focused work started", onSuccess: onClose },
  );
  const area = (key: keyof typeof f, label: string) => (
    <Field id={`pk-${key}`} label={label}>
      <textarea id={`pk-${key}`} className={`${inputCls} min-h-16`} value={f[key] as string} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </Field>
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={prev ? `Revise work packet (v${prev.version + 1})` : "Start focused work"}
      description="A work packet is an immutable handoff snapshot. Ready and in-progress work needs a next action."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="packet-form" busy={save.isPending}>
            Save packet
          </Button>
        </>
      }
    >
      <form
        id="packet-form"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined);
        }}
      >
        <Field id="pk-objective" label="Objective">
          <textarea
            id="pk-objective"
            data-autofocus
            required
            className={`${inputCls} min-h-16`}
            value={f.objective}
            onChange={(e) => setF({ ...f, objective: e.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          {area("inScope", "In scope")}
          {area("outOfScope", "Out of scope")}
        </div>
        {area("acceptanceCriteria", "Acceptance criteria")}
        <div className="grid gap-3 sm:grid-cols-2">
          {area("decisions", "Decisions")}
          {area("openQuestions", "Open questions")}
        </div>
        {area("context", "Context")}
        <Field id="pk-next" label="Next action">
          <input id="pk-next" required className={inputCls} value={f.nextAction} onChange={(e) => setF({ ...f, nextAction: e.target.value })} />
        </Field>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Move to</legend>
          {(["in_progress", "ready"] as const).map((s) => (
            <label key={s} className="flex min-h-11 items-center gap-2 text-sm">
              <input type="radio" name="pk-status" checked={f.status === s} onChange={() => setF({ ...f, status: s })} />
              {STATUS_LABELS[s]}
            </label>
          ))}
        </fieldset>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={f.validationRequired} onChange={(e) => setF({ ...f, validationRequired: e.target.checked })} />
          Validation required before settling
        </label>
        {!f.validationRequired ? (
          <Field id="pk-novalidation" label="Why no validation is needed">
            <input
              id="pk-novalidation"
              required
              className={inputCls}
              value={f.noValidationReason}
              onChange={(e) => setF({ ...f, noValidationReason: e.target.value })}
            />
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}

function SettleDialog({ open, onClose, d }: { open: boolean; onClose: () => void; d: WorkDetail }) {
  const [reason, setReason] = useState("");
  const settle = useWorkMutation(() => api.post(`/api/work/items/${encodeURIComponent(d.item.id)}/settle`, { reason }), { ok: "Settled", onSuccess: onClose });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Settle ${d.item.title}`}
      description={d.settle.allowed ? "Record the outcome. You can reopen any time." : d.settle.reason}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!d.settle.allowed} busy={settle.isPending} onClick={() => settle.mutate(undefined)}>
            Settle
          </Button>
        </>
      }
    >
      <Field id="st-reason" label="Outcome (optional)">
        <textarea id="st-reason" data-autofocus className={textareaCls} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function ReopenDialog({ open, onClose, item, onFollowUp }: { open: boolean; onClose: () => void; item: WorkItem; onFollowUp: (id: string) => void }) {
  const [reason, setReason] = useState("");
  const [followUp, setFollowUp] = useState("");
  const reopen = useWorkMutation(
    () =>
      api.post<{ item: WorkItem; followUp: WorkItem | null }>(`/api/work/items/${encodeURIComponent(item.id)}/reopen`, {
        reason,
        followUpTitle: followUp || undefined,
      }),
    {
      ok: "Reopened",
      onSuccess: (r) => {
        onClose();
        if (r.followUp) onFollowUp(r.followUp.id);
      },
    },
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Reopen ${item.title}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!reason.trim()} busy={reopen.isPending} onClick={() => reopen.mutate(undefined)}>
            Reopen
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field id="ro-reason" label="Why is it reopening?">
          <textarea id="ro-reason" data-autofocus className={textareaCls} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field id="ro-follow" label="Follow-up child (optional)" hint="Creates a linked child item for the next round of work.">
          <input id="ro-follow" className={inputCls} value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

const RELATION: Record<string, string> = { forked_from: "Forked from", split_from: "Split from", moved_from: "Moved from", handoff_from: "Follow-up of" };

function Activity({ d, onSelect }: { d: WorkDetail; onSelect: (id: string) => void }) {
  const { item } = d;
  return (
    <>
      <Card>
        <h3 className="mb-2 font-semibold">Lineage</h3>
        {d.links.some((l) => l.lineage === "handoff_from") ? (
          <ul className="mb-2 space-y-1 text-sm">
            {d.links
              .filter((l) => l.lineage === "handoff_from")
              .map((l) => {
                const p = d.packets.find((x) => x.id === l.packetId);
                return (
                  <li key={l.id}>
                    Handed off to{" "}
                    <Link href={`/chat/${encodeURIComponent(l.targetId ?? "")}`} className="tap text-accent underline">
                      {l.title}
                    </Link>{" "}
                    <span className="text-muted">
                      · {p ? `packet v${p.version}` : "no packet"} · {fmtDate(l.createdAt)}
                    </span>
                  </li>
                );
              })}
          </ul>
        ) : null}
        {d.lineage.length ? (
          <ul className="space-y-1 text-sm">
            {d.lineage.map((l) => {
              const mine = l.childId === item.id;
              const otherId = mine ? l.parentId : l.childId;
              const otherTitle = mine ? l.parentTitle : l.childTitle;
              const text = mine ? RELATION[l.relation] : l.relation === "moved_from" ? null : `${RELATION[l.relation]?.replace(/ (from|of)$/, "")} into`;
              if (!text) return null;
              return (
                <li key={l.id}>
                  {text}{" "}
                  {otherId && otherTitle ? (
                    <button type="button" className="tap text-accent underline" onClick={() => onSelect(otherId)}>
                      {otherTitle}
                    </button>
                  ) : (
                    <span className="text-muted">(top level)</span>
                  )}{" "}
                  <span className="text-muted">· {fmtDate(l.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        ) : d.links.some((l) => l.lineage === "handoff_from") ? null : (
          <p className="text-sm text-muted">No forks, splits or moves.</p>
        )}
      </Card>
      <Card>
        <h3 className="mb-2 font-semibold">Activity</h3>
        <ol className="space-y-2 text-sm">
          {d.events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-2">
              <time dateTime={e.at} className="text-muted">
                {new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </time>
              <span className="break-words">
                {e.kind === "status" && e.toStatus
                  ? `${e.fromStatus ? STATUS_LABELS[e.fromStatus as WorkStatus] : "—"} → ${STATUS_LABELS[e.toStatus as WorkStatus]}${e.reason ? `: ${e.reason}` : ""}`
                  : e.kind === "created"
                    ? `Created${e.reason ? `: ${e.reason}` : ""}`
                    : (e.reason ?? e.kind)}
              </span>
              {e.source === "github" ? <Badge>GitHub</Badge> : null}
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
