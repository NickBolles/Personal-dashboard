"use client";

import Link from "next/link";
import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { useAccess } from "@/components/access";
import { Dialog, ErrorNote, OverflowMenu, PageHeader, useToast } from "@/components/ui";
import { Button, ButtonLink, ChipSelect, EmptyState, Pill, type KTone } from "@/components/ui/kit";
import { ThumbDownIcon, ThumbUpIcon } from "@/components/icons";
import { UndoBar, type UndoOp } from "@/components/work/UndoBar";
import { UndoStrip } from "./RateMessage";
import {
  FEEDBACK_RATINGS,
  FEEDBACK_REASONS,
  FEEDBACK_REASON_LABELS,
  FEEDBACK_STATUSES,
  FEEDBACK_STATUS_LABELS,
  FEEDBACK_SURFACE_LABELS,
  messageLink,
  reasonsText,
  type Feedback,
  type FeedbackFilter,
  type FeedbackList,
  type FeedbackStatus,
} from "@/lib/feedback";

const STATUS_TONE: Record<FeedbackStatus, KTone> = { new: "inf", triaged: "ai", fixed: "ok", wont_fix: "neutral" };

function query(f: FeedbackFilter) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Feedback inbox (/feedback): every rating with filters, status, export and "Create item". */
export function FeedbackInbox() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { can } = useAccess();
  const [filter, setFilter] = useState<FeedbackFilter>({ rating: "down" });
  const q = useQuery({ queryKey: ["feedback", "inbox", filter], queryFn: () => api.get<FeedbackList>(`/api/feedback${query(filter)}`) });
  const [undo, setUndo] = useState<{ label: string; run: () => Promise<void>; id: number } | null>(null);
  const undoSeq = useRef(0);
  const [op, setOp] = useState<UndoOp | null>(null);
  const [confirm, setConfirm] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["feedback"] });
  const set = (k: keyof FeedbackFilter, v: string) => setFilter((f) => ({ ...f, [k]: v || undefined }));

  const setStatus = async (e: Feedback, status: FeedbackStatus) => {
    try {
      await api.patch(`/api/feedback/${encodeURIComponent(e.id)}`, { status });
      await refresh();
      setUndo({
        label: `Marked ${FEEDBACK_STATUS_LABELS[status].toLowerCase()}`,
        id: ++undoSeq.current,
        run: async () => {
          await api.patch(`/api/feedback/${encodeURIComponent(e.id)}`, { status: e.status });
          await refresh();
        },
      });
    } catch (err) {
      toast((err as Error).message, "danger");
    }
  };
  const createItem = async (e: Feedback) => {
    setBusy(true);
    try {
      const r = await api.post<{ itemId: string; op: UndoOp | null }>(`/api/feedback/${encodeURIComponent(e.id)}/item`);
      await refresh();
      void qc.invalidateQueries({ queryKey: ["work"] });
      setConfirm(null);
      toast("Item created", "ok");
      if (r.op) setOp({ ...r.op, label: "Item created" });
    } catch (err) {
      toast((err as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };

  const data = q.data;
  const active = Object.values(filter).some(Boolean);
  return (
    <div className="space-y-3" data-testid="feedback-inbox">
      <PageHeader
        title="Feedback"
        subtitle="Your ratings of agent replies. Bad ones can be fixed in place, filed as an item, or picked up by the daily triage job."
        actions={
          <a href="/api/feedback/export" download className="k-btn k-btn-secondary k-btn-sm" data-testid="feedback-export">
            Export JSON
          </a>
        }
      />
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5" role="group" aria-label="Filters">
        <ChipSelect
          aria-label="Rating"
          value={filter.rating ?? ""}
          active={!!filter.rating}
          onChange={(e) => set("rating", e.target.value)}
          className="w-28 [&>select]:w-full"
        >
          <option value="">All ratings</option>
          {FEEDBACK_RATINGS.map((r) => (
            <option key={r} value={r}>
              {r === "up" ? "Good" : "Bad"}
            </option>
          ))}
        </ChipSelect>
        <ChipSelect
          aria-label="Status"
          value={filter.status ?? ""}
          active={!!filter.status}
          onChange={(e) => set("status", e.target.value)}
          className="w-28 [&>select]:w-full"
        >
          <option value="">Any status</option>
          {FEEDBACK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {FEEDBACK_STATUS_LABELS[s]}
            </option>
          ))}
        </ChipSelect>
        <ChipSelect
          aria-label="Reason"
          value={filter.reason ?? ""}
          active={!!filter.reason}
          onChange={(e) => set("reason", e.target.value)}
          className="w-32 [&>select]:w-full"
        >
          <option value="">Any reason</option>
          {FEEDBACK_REASONS.map((r) => (
            <option key={r} value={r}>
              {FEEDBACK_REASON_LABELS[r]}
            </option>
          ))}
        </ChipSelect>
        <ChipSelect
          aria-label="Profile"
          value={filter.profile ?? ""}
          active={!!filter.profile}
          onChange={(e) => set("profile", e.target.value)}
          className="w-32 [&>select]:w-full"
        >
          <option value="">Any profile</option>
          {(data?.profiles ?? []).map((p) => (
            <option key={p} value={p}>
              @{p}
            </option>
          ))}
        </ChipSelect>
        <ChipSelect
          aria-label="Area"
          value={filter.areaId ?? ""}
          active={!!filter.areaId}
          onChange={(e) => set("areaId", e.target.value)}
          className="w-32 [&>select]:w-full"
        >
          <option value="">Any area</option>
          {(data?.areas ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </ChipSelect>
        {active ? (
          <Button size="sm" variant="ghost" onClick={() => setFilter({})}>
            Clear
          </Button>
        ) : null}
        {data ? (
          <span className="ml-auto text-xs text-muted" data-testid="feedback-counts">
            {data.counts.newDown} new bad · {data.counts.total} total
          </span>
        ) : null}
      </div>
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {data && !data.entries.length ? (
        <EmptyState title={data.counts.total ? "Nothing matches these filters" : "No feedback yet"}>
          {data.counts.total
            ? "Clear a filter to see more."
            : "Rate any agent reply with the thumbs up or down in its message actions (hover, or tap the message on a phone)."}
        </EmptyState>
      ) : null}
      {data?.entries.length ? (
        <ul className="divide-y divide-line rounded-[12px] border border-line bg-surface" aria-label="Feedback" data-testid="feedback-list">
          {data.entries.map((e) => (
            <FeedbackRow key={e.id} e={e} canItem={can("work.use")} onStatus={(s) => void setStatus(e, s)} onCreateItem={() => setConfirm(e)} />
          ))}
        </ul>
      ) : null}
      {confirm ? (
        <Dialog
          open
          onClose={() => setConfirm(null)}
          title="Create an item from this feedback?"
          description={
            confirm.areaTitle ? `A thread in ${confirm.areaTitle}, linking back to the message.` : "A thread in Miscellaneous, linking back to the message."
          }
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" loading={busy} onClick={() => void createItem(confirm)} data-testid="feedback-create-item">
                Create item
              </Button>
            </>
          }
        >
          <p className="text-sm">
            {reasonsText(confirm.reasons) || "Not right"}
            {confirm.note ? ` · ${confirm.note}` : ""}
          </p>
        </Dialog>
      ) : null}
      {undo ? <UndoStrip key={undo.id} label={undo.label} onUndo={undo.run} onDone={() => setUndo(null)} /> : null}
      {op ? (
        <UndoBar
          key={op.id}
          op={op}
          onDone={() => setOp(null)}
          onUndone={() => {
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function FeedbackRow({
  e,
  canItem,
  onStatus,
  onCreateItem,
}: {
  e: Feedback;
  canItem: boolean;
  onStatus: (s: FeedbackStatus) => void;
  onCreateItem: () => void;
}) {
  const titleId = useId();
  const items = [
    ...FEEDBACK_STATUSES.filter((s) => s !== e.status).map((s) => ({ label: `Mark ${FEEDBACK_STATUS_LABELS[s].toLowerCase()}`, onSelect: () => onStatus(s) })),
    ...(canItem && !e.itemId ? [{ label: "Create item…", onSelect: onCreateItem }] : []),
  ];
  return (
    <li className="flex min-w-0 items-start gap-2.5 px-3 py-2.5" aria-labelledby={titleId} data-testid="feedback-row">
      <span className={e.rating === "up" ? "mt-0.5 text-ok" : "mt-0.5 text-danger"}>
        {e.rating === "up" ? <ThumbUpIcon className="h-4 w-4" /> : <ThumbDownIcon className="h-4 w-4" />}
        <span className="sr-only">{e.rating === "up" ? "Good" : "Bad"}</span>
      </span>
      <div className="min-w-0 flex-1">
        <p id={titleId} className="text-sm font-medium [overflow-wrap:anywhere]">
          {e.rating === "down" ? reasonsText(e.reasons) || "Not right" : "Good reply"}
          {e.note ? <span className="font-normal text-muted"> · {e.note}</span> : null}
        </p>
        {e.excerpt ? <p className="mt-0.5 line-clamp-2 text-sm text-muted [overflow-wrap:anywhere]">“{e.excerpt}”</p> : null}
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted">
          <Pill tone={STATUS_TONE[e.status]}>{FEEDBACK_STATUS_LABELS[e.status]}</Pill>
          <span>@{e.profile}</span>
          <span>{FEEDBACK_SURFACE_LABELS[e.surface]}</span>
          {e.areaTitle ? <span>{e.areaTitle}</span> : null}
          {e.fixRequestedAt ? <Pill tone="ai">Fix asked</Pill> : null}
          <span data-dynamic>{new Date(e.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          <Link href={messageLink("", e.sessionId, e.messageId)} className="text-accent hover:underline">
            Open message
          </Link>
          {e.itemId ? (
            <Link href={`/areas?item=${encodeURIComponent(e.itemId)}`} className="text-accent hover:underline">
              Item: {e.itemTitle}
            </Link>
          ) : null}
        </div>
      </div>
      <OverflowMenu label={`More for feedback ${e.rating === "down" ? reasonsText(e.reasons) || "Not right" : "Good reply"}`} items={items} />
    </li>
  );
}

/** Settings → Agents entry: counts + link to the inbox. */
export function FeedbackSettingsCard() {
  const q = useQuery({ queryKey: ["feedback", "inbox", { rating: "down" }], queryFn: () => api.get<FeedbackList>("/api/feedback?rating=down") });
  return (
    <section
      className="flex flex-wrap items-center gap-2 rounded-[12px] border border-line bg-surface px-4 py-3"
      aria-label="Feedback"
      data-testid="feedback-settings-card"
    >
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">Feedback</h2>
        <p className="text-sm text-muted">
          {q.data ? `${q.data.counts.newDown} new bad · ${q.data.counts.total} ratings.` : "Ratings of agent replies."} The “Daily feedback triage” job above
          sends new bad ratings to Chief of staff when you turn it on.
        </p>
      </div>
      <ButtonLink href="/feedback" size="sm">
        Open feedback
      </ButtonLink>
    </section>
  );
}
