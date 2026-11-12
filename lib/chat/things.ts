import type { PanelLink } from "@/server/chat/links";
import { isActiveExec, type ChatExecutionResponse, type ExecutionRecord } from "@/lib/chat-execution";
import { priorityLine, stablePriority, type PriorityLine } from "@/lib/coordinator/things";
import { plainMessageLine } from "@/lib/chat/display";

export type ChatTab = "Links" | "Artifacts" | "PRs" | "Running" | "Files" | "Context";
export type WorkflowTab = "Outline" | "Form" | "Notes" | "Outputs";
export type ThingsTab = ChatTab | WorkflowTab;
export type ChatPriority = Omit<PriorityLine, "state"> & {
  id: string;
  attentionKey: string;
  state: "failing" | "needs" | "finished" | "step" | "merged" | "running" | "quiet";
  label: string;
  tab: ThingsTab;
  action?: string;
  since: number;
};
export type ChatThingsInput = {
  links: PanelLink[];
  execution?: ChatExecutionResponse;
  executionUnavailable?: boolean;
  pending?: {
    approval?: boolean;
    clarify?: boolean;
    decision?: boolean;
    form?: boolean;
    /** What the approval or question in the conversation is about, in its own words (e.g. "Recursive delete"). */
    detail?: string | null;
    /** The run that is waiting on it: that run’s own execution record says the same thing and is not listed twice. */
    runId?: string | null;
  };
  workflow?: { title: string; step?: string; due?: boolean; sections: { title: string; count: number }[] } | null;
  filesCount?: number | null;
  contextPercent?: number | null;
  parentRunning?: boolean;
  parentFailed?: boolean;
  /** This chat is known to have started background work (handed off to agents, started a run), so a failed status check matters. */
  expectsBackground?: boolean;
  seen?: readonly string[];
  previous?: ChatPriority;
  /** Time a downward transition was first observed, for shared hysteresis. */
  transitionSince?: number;
  now?: number;
};
const ranks: Record<ChatPriority["state"], number> = { failing: 6, needs: 5, finished: 4, step: 3, merged: 2, running: 1, quiet: 0 };
const coarse = (line: ChatPriority): PriorityLine => ({
  ...line,
  state: line.state === "quiet" ? "idle" : line.state === "finished" || line.state === "step" || line.state === "merged" ? "done" : line.state,
});
export function isFailingLink(link: PanelLink) {
  // PanelLink exposes only its reported state, not a CI/deploy pipeline.
  return link.kind === "github" && /^(failed|failing|failure|error)$/i.test(link.state ?? "");
}
/** Viewing a running record must not acknowledge its future completion/failure. */
export const executionAttentionKey = (record: ExecutionRecord) => `${record.key}:${record.state}`;
export const linkAttentionKey = (link: PanelLink) => `${link.url}:${link.state ?? "unknown"}`;
export function chatThings(input: ChatThingsInput) {
  const now = input.now ?? 0;
  // Background work is often titled with the message that started it: show the person's words, not the "[Viewing: …]" wrapper.
  const records = (input.execution?.records ?? []).map((r) => ({ ...r, title: plainMessageLine(r.title) || r.title }));
  const unavailable =
    !!input.executionUnavailable || !input.execution || !input.execution.sources.length || input.execution.sources.some((s) => s.state !== "ok");
  // A real failure to check (request failed, nothing reported, or a source could not be read). "stale" is the
  // standing caveat on sources that are never authoritative, not a failure worth the owner's attention.
  const checkFailed =
    !!input.executionUnavailable || (!!input.execution && (!input.execution.sources.length || input.execution.sources.some((s) => s.state === "unavailable")));
  const active = records.filter(isActiveExec);
  const prs = input.links.filter((l) => l.kind === "github" && l.ghType === "pull");
  const failing = prs.filter(isFailingLink);
  const candidates: ChatPriority[] = [];
  const add = (id: string, state: ChatPriority["state"], label: string, text: string, tab: ThingsTab, action?: string, attentionKey = id) => {
    const base = priorityLine({
      failing: state === "failing" ? 1 : 0,
      needsYou: state === "needs" || state === "step" || state === "merged" ? 1 : 0,
      doneUnseen: state === "finished" ? 1 : 0,
      running: state === "running" ? 1 : 0,
    });
    candidates.push({ ...base, id, attentionKey, state, label, text, tab, action, since: now });
  };
  for (const r of records.filter((r) => r.state === "failed")) add(r.key, "failing", "Failing", r.title, "Running", "Review", executionAttentionKey(r));
  for (const l of failing) add(l.url, "failing", "Failing", l.title, "PRs", "Review", linkAttentionKey(l));
  if (input.parentFailed) add("parent-failed", "failing", "Failing", "This response failed", "Running", "Review");
  const pending = input.pending;
  // The request’s own description, never the message that started the run (that reads as if the owner’s words were the approval).
  const detail = (pending?.detail ?? "").replace(/\s+/g, " ").trim();
  if (pending?.approval) add("approval", "needs", "Needs you", detail || "Approval waiting in the conversation", "Running", "Review");
  if (pending?.clarify) add("clarify", "needs", "Needs you", (!pending.approval && detail) || "A question is waiting in the conversation", "Running", "Answer");
  const asked = pending?.approval || pending?.clarify ? pending.runId : null;
  if (pending?.decision) add("decision", "needs", "Needs you", "A decision is waiting", "Context", "Review");
  if (pending?.form) add("form", "needs", "Needs you", "Complete the session form", "Form", "Open");
  for (const r of records.filter((r) => r.state === "waiting" && !(asked && r.id === asked)))
    add(r.key, "needs", "Needs you", r.title, "Running", "Review", executionAttentionKey(r));
  for (const r of records.filter((r) => r.state === "completed" && !input.seen?.includes(executionAttentionKey(r))))
    add(r.key, "finished", "Finished", r.title, "Running", "Read", executionAttentionKey(r));
  if (input.workflow?.due) add("workflow-step", "step", "Next step", input.workflow.step ?? input.workflow.title, "Outline", "Open");
  for (const l of prs.filter((l) => l.state === "merged"))
    add(l.url, "merged", "Merged", `${l.title} · no deploy record`, "PRs", "Review", linkAttentionKey(l));
  for (const r of active.filter((r) => r.state === "running")) add(r.key, "running", "Running", r.step ?? r.title, "Running");
  if (input.workflow && !input.workflow.due) add("workflow", "running", "Live", input.workflow.step ?? input.workflow.title, "Outline", "Open");
  if (input.parentRunning) add("parent-running", "running", "Working", "Responding in this chat", "Running");
  // Nothing needs attention (the tray shows no status line then). A failed status check is not this chat's
  // headline: it surfaces as `notice`, and only when it matters.
  add("quiet", "quiet", "Quiet", "Everything in this chat, in one place", "Links");
  candidates.sort((a, b) => ranks[b.state] - ranks[a.state]);
  let line = candidates[0]!;
  const prev = input.previous;
  if (prev) {
    const current = candidates.find((c) => c.id === prev.id && c.state === prev.state);
    if (ranks[line.state] === ranks[prev.state] && current) {
      if (now - prev.since < 60_000) line = { ...current, since: prev.since };
      else {
        const peers = candidates.filter((c) => c.state === line.state);
        line = peers[(peers.findIndex((c) => c.id === prev.id) + 1) % peers.length]!;
        if (line.id === prev.id) line = { ...line, since: prev.since };
      }
    } else if (ranks[line.state] < ranks[prev.state]) {
      const stable = stablePriority(coarse(prev), coarse(line), input.transitionSince ?? now, now);
      if (stable.state === coarse(prev).state && now - (input.transitionSince ?? now) < 4000) line = prev;
    }
  }
  const unseen = candidates.filter((c) => !input.seen?.includes(c.attentionKey));
  const dot: PriorityLine["dot"] = unseen.some((c) => c.state === "failing")
    ? "red"
    : unseen.some((c) => ["needs", "finished", "step", "merged"].includes(c.state))
      ? "yellow"
      : null;
  return {
    counts: {
      links: input.links.length,
      artifacts: input.links.filter((l) => l.kind === "artifact").length,
      prs: { total: prs.length, failing: failing.length },
      running: unavailable && !active.length ? null : active.length,
      files: input.filesCount ?? null,
      context: input.contextPercent == null || !Number.isFinite(input.contextPercent) ? null : Math.max(0, Math.min(100, input.contextPercent)),
    },
    line: { ...line, dot },
    unavailable,
    /** "Couldn't check background work" is worth a line in the tray: the check really failed and this chat has (or had) background work. */
    notice: checkFailed && (!!input.expectsBackground || records.length > 0 || !!input.parentRunning),
    workflow: input.workflow,
  };
}
export type ChatThings = ReturnType<typeof chatThings>;

/** A count worth a chip in the tray: only things that exist. */
export type TrayChip = { tab: ChatTab; count: number; tone: "neutral" | "bad" | "ai"; dot: "red" | null };

/**
 * What the composer tray shows. Idle chats with nothing in them show nothing at all:
 * - `status`: the priority line, only while something is failing, waiting, finished-unread or running;
 * - `chips`: only non-zero counts (a zero or an unknown "—" is never a peer of a real one);
 * - `notice`: the background-work check failed and it matters here (plain words + Retry).
 */
export function trayContent(things: Pick<ChatThings, "counts" | "line" | "notice" | "workflow">) {
  const { counts, line } = things;
  const chips: TrayChip[] = [];
  if (counts.prs.total > 0)
    chips.push({ tab: "PRs", count: counts.prs.total, tone: counts.prs.failing ? "bad" : "neutral", dot: counts.prs.failing ? "red" : null });
  const status = line.state === "quiet" ? null : line;
  // One running thing is already the status line; the chip earns its place when it adds a count.
  if (counts.running && !(status?.state === "running" && counts.running === 1)) chips.push({ tab: "Running", count: counts.running, tone: "ai", dot: null });
  if (counts.artifacts > 0) chips.push({ tab: "Artifacts", count: counts.artifacts, tone: "neutral", dot: null });
  if (counts.files) chips.push({ tab: "Files", count: counts.files, tone: "neutral", dot: null });
  if (counts.context) chips.push({ tab: "Context", count: counts.context, tone: "ai", dot: null });
  return { status, chips, notice: things.notice, empty: !status && !chips.length && !things.notice && !things.workflow };
}
