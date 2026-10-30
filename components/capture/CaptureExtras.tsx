"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/client/api";
import { Badge, Button, Dialog, OverflowMenu, type MenuItem } from "@/components/ui";
import { useAccess } from "@/components/access";
import { useWorkMutation } from "@/components/work/common";
import { ReportViewer } from "@/components/work/ai/AiActions";
import type { InboxEntry, WorkItem } from "@/lib/work";

const CHANNEL_LABEL: Record<string, string> = { pwa_share: "Shared", shortcut: "Shortcut", android: "Phone", voice: "Voice", web: "Web", api: "API" };
const SKIP_TEXT: Record<string, string> = {
  finance_detected: "Not sent to AI: looks like finance. File it yourself.",
  credentials_detected: "Not sent to AI: looks like it contains a credential.",
  ai_disabled: "",
  ai_not_allowed: "",
  off: "",
  budget: "Waiting for today's AI budget.",
};

/** Phase 5 additions to a capture row: triage state, one-tap filing under the suggestion, report, thumbnails, investigate. */
export function CaptureExtras({ entry, onAccepted, onChoose }: { entry: InboxEntry; onAccepted: (id: string) => void; onChoose?: () => void }) {
  const c = entry.capture!;
  const [report, setReport] = useState<string | null>(null);
  // Long-press on the suggestion chip = "Choose…" (pick another destination); a tap files under it.
  const hold = useRef<{ t: ReturnType<typeof setTimeout> | null; fired: boolean }>({ t: null, fired: false });
  const endHold = () => {
    if (hold.current.t) clearTimeout(hold.current.t);
    hold.current.t = null;
  };
  const file = useWorkMutation(
    () => api.post<{ item: WorkItem }>(`/api/work/inbox/${encodeURIComponent(entry.id)}/accept`, { parentId: null, useSuggestion: true }),
    { ok: "Filed", onSuccess: (r) => onAccepted(r.item.id) },
  );
  const skip = c.triageState === "skipped" && c.triageSkipReason ? SKIP_TEXT[c.triageSkipReason] : "";
  return (
    <div className="mt-1 space-y-1">
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        {c.channel && c.channel !== "web" ? <Badge>{CHANNEL_LABEL[c.channel] ?? c.channel}</Badge> : null}
        {c.triageState === "queued" ? <span className="ai-shimmer">Triaging…</span> : null}
        {c.suggestedKind ? <Badge tone="accent">{c.suggestedKind.replace("_", " ")}</Badge> : null}
        {c.suggestedTitle && c.suggestedTitle !== entry.title ? <span>Suggested: “{c.suggestedTitle}”</span> : null}
        {c.investigating ? <span className="ai-shimmer">Investigating…</span> : null}
      </p>
      {skip ? <p className="text-xs text-muted">{skip}</p> : null}
      {c.attachments.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Attachments">
          {c.attachments.map((a) =>
            a.kind === "image" ? (
              <li key={a.id}>
                <a href={a.url} target="_blank" rel="noopener noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element -- authenticated same-origin attachment */}
                  <img src={a.url} alt="Captured image" className="h-12 w-12 rounded-md border border-line object-cover" loading="lazy" />
                </a>
              </li>
            ) : (
              <li key={a.id}>
                <a className="tap text-xs underline" href={a.url}>
                  Text file
                </a>
              </li>
            ),
          )}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {c.suggestion ? (
          <button
            type="button"
            onClick={() => {
              if (hold.current.fired) {
                hold.current.fired = false;
                return;
              }
              file.mutate(undefined);
            }}
            onPointerDown={() => {
              if (!onChoose) return;
              hold.current.fired = false;
              hold.current.t = setTimeout(() => {
                hold.current.fired = true;
                onChoose();
              }, 500);
            }}
            onPointerUp={endHold}
            onPointerLeave={endHold}
            onPointerCancel={endHold}
            onContextMenu={(e) => {
              if (!onChoose) return;
              e.preventDefault();
            }}
            disabled={file.isPending}
            aria-busy={file.isPending || undefined}
            aria-label={`File under ${c.suggestion.title}`}
            data-testid="file-under-suggestion"
            title={[c.suggestion.reason, onChoose ? "Tap to file · hold to choose another place" : null].filter(Boolean).join(" · ") || undefined}
            className="ai-chip inline-flex min-h-11 max-w-full items-center gap-1 rounded-full px-3 text-[13px] font-medium select-none disabled:opacity-60 sm:min-h-8"
          >
            <span aria-hidden="true">→</span>
            <span className="min-w-0 truncate">{c.suggestion.title}</span>
            {c.suggestion.confidence != null ? <span className="tabular-nums opacity-70">{Math.round(c.suggestion.confidence * 100)}%</span> : null}
          </button>
        ) : null}
        {c.report ? (
          <Button size="sm" variant="ghost" onClick={() => setReport(c.report!.id)} data-testid="report-ready">
            ✦ Report ready<span className="sr-only">: {c.report.title}</span>
          </Button>
        ) : null}
      </div>
      {report ? <ReportViewer reportId={report} onClose={() => setReport(null)} /> : null}
    </div>
  );
}

/**
 * The ⋯ menu of a capture row: Investigate (work.ai) and "Send anyway…" for
 * finance-looking captures live here with Dismiss, so the row keeps one
 * visible action (File/suggestion).
 */
export function CaptureRowMenu({ entry, label, onDismiss }: { entry: InboxEntry; label: string; onDismiss: () => void }) {
  const c = entry.capture!;
  const canAi = useAccess().can("work.ai");
  const [confirm, setConfirm] = useState(false);
  const investigate = useWorkMutation(
    (financeOverride: boolean) => api.post(`/api/work/inbox/${encodeURIComponent(entry.id)}/investigate`, financeOverride ? { financeOverride: true } : {}),
    { ok: "Jarvis is looking into it", onSuccess: () => setConfirm(false) },
  );
  const items: MenuItem[] = [];
  if (canAi && !c.report && !c.investigating && c.sensitivity !== "credentials" && c.sensitivity !== "finance" && c.triageState !== "queued")
    items.push({ label: "Investigate", onSelect: () => investigate.mutate(false) });
  if (canAi && c.sensitivity === "finance") items.push({ label: "Send to AI anyway…", onSelect: () => setConfirm(true) });
  items.push({ label: "Dismiss", onSelect: onDismiss, danger: true });
  return (
    <>
      <OverflowMenu label={label} items={items} />
      {confirm ? (
        <Dialog
          open
          onClose={() => setConfirm(false)}
          title="Send to AI anyway?"
          description="This capture looks like finance. Jarvis keeps finance away from AI unless you confirm. This is recorded in the audit log."
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button variant="danger" busy={investigate.isPending} onClick={() => investigate.mutate(true)}>
                Send anyway
              </Button>
            </>
          }
        />
      ) : null}
    </>
  );
}
