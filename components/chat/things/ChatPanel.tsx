"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { Button, ChipButton, KSpinner, Pill, ProgressBar } from "@/components/ui";
import { BrainIcon, ForkIcon, ToolIcon } from "@/components/icons";
import { safeHref } from "@/components/markdown/Markdown";
import { isActiveExec, type ChatExecutionResponse, type ExecutionRecord } from "@/lib/chat-execution";
import { executionTitle, presentExecutions } from "@/lib/chat/execution-presentation";
import { isFailingLink, type ChatThings, type ThingsTab } from "@/lib/chat/things";
import type { PanelLink } from "@/server/chat/links";
import { relativeTime } from "@/lib/time";
import { FilesSection } from "../Attachments";
import { LinksPanel } from "../LinksPanel";
import type { ContextChip } from "../ContextSheet";
import { RunPanel, type RunPanelView, type AgentCaptureState } from "@/components/workflows/RunPanel";
import { SummaryChip } from "./SummaryChip";
import { ChatSheet } from "./ChatSheet";

export function ParentChatLink({ parent }: { parent?: ChatExecutionResponse["parent"] }) {
  return parent && internalHref(parent.href) ? (
    <Link className="inline-flex min-h-11 items-center text-xs text-accent underline sm:min-h-10 dense:min-h-8" href={parent.href}>
      ↩ Back to parent chat
    </Link>
  ) : null;
}
function internalHref(href: string) {
  return href.startsWith("/") && !href.startsWith("//") && safeHref(href) === href;
}
export function RunningSection({
  execution,
  error,
  loading,
  retry,
  pending,
}: {
  execution?: ChatExecutionResponse;
  error?: boolean;
  loading?: boolean;
  retry: () => void;
  pending?: ReactNode;
}) {
  const allOk = !error && !!execution?.sources.length && execution.sources.every((s) => s.state === "ok");
  const records = execution?.records ?? [];
  const failed = !!error || (!loading && !execution) || execution?.sources.length === 0 || !!execution?.sources.some((s) => s.state === "unavailable");
  const correlated = presentExecutions(records);
  // A relationship can contain a live parent and a failed child. Pick one section for the relationship, then retain
  // every member within it; filtering first would silently lose that child.
  const groups = [
    { title: "Running", records: correlated.filter((g) => g.members.some(isActiveExec)) },
    {
      title: "Finished",
      records: correlated.filter((g) => !g.members.some(isActiveExec) && g.members.some((r) => ["completed", "failed", "cancelled"].includes(r.state))),
    },
    { title: "Status unknown", records: correlated.filter((g) => g.members.every((r) => r.state === "unknown")) },
  ];
  return (
    <div className="space-y-3 text-sm" data-testid="chat-running">
      <ParentChatLink parent={execution?.parent} />
      {pending}
      {loading && !execution ? <KSpinner label="Loading agents and jobs…" /> : null}
      {/* One plain line when the check failed. Which source it was, and a saved status that may be old, are not
          the owner's to read: what is known stays listed below either way. */}
      {failed ? (
        <p className="text-xs text-muted" role="status">
          Couldn&apos;t check background work.{" "}
          <Button size="sm" onClick={retry}>
            Retry
          </Button>
        </p>
      ) : null}
      {groups
        .filter((g) => g.records.length)
        .map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h4 className="mb-1 text-xs font-semibold text-muted">{g.title}</h4>
            <ul className="space-y-2">
              {g.records.map(({ key, members }) => (
                <li key={key} className="cp-run-group">
                  <ul className="space-y-1">
                    {members.map((record) => (
                      <ExecutionRow key={record.key} record={record} />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        ))}
      {!records.length && allOk ? <p className="text-muted">No agents or jobs for this chat</p> : null}
      {/* Not every source answered freshly, so "none" is not claimed: only that nothing is known to be running. */}
      {!records.length && !allOk && !failed && execution ? <p className="text-muted">Nothing running that Jarvis knows of</p> : null}
    </div>
  );
}
function ExecutionRow({ record: r }: { record: ExecutionRecord }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const Icon = r.source === "process" ? ToolIcon : r.source === "fork" ? ForkIcon : BrainIcon;
  const when = r.updatedAt ?? r.startedAt ?? r.endedAt;
  const tone = r.state === "failed" ? "bad" : r.state === "completed" ? "ok" : r.state === "waiting" ? "wn" : r.state === "running" ? "ai" : "neutral";
  const label = executionTitle(r);
  const ids = [r.subagentId, r.delegationId, r.id].filter((id): id is string => !!id);
  return (
    <li className="cp-run" data-state={r.state}>
      <details>
        <summary className="cp-run-summary">
          <Icon className="h-4 w-4 shrink-0" />
          <span className="cp-run-main">
            <span className="cp-run-title">{label}</span>
            {r.step ? <span className="cp-run-step">{r.step}</span> : null}
          </span>
          <Pill tone={tone}>{r.state}</Pill>
          {when ? (
            <time className="cp-run-time" dateTime={when} title={when}>
              {relativeTime(when)}
            </time>
          ) : null}
        </summary>
        <div className="cp-run-detail">
          {r.summary ? <p className="whitespace-pre-wrap">{r.summary}</p> : null}
          {r.error ? <p className="whitespace-pre-wrap text-danger">{r.error}</p> : null}
          {r.progress != null && Number.isFinite(r.progress) ? (
            <ProgressBar value={Math.min(100, Math.max(0, r.progress * 100))} tone="ai" label={`${label} progress`} />
          ) : null}
          {r.href && internalHref(r.href) ? (
            <Link className="text-accent underline" href={r.href}>
              {r.childSessionId ? `Open child chat · @${r.childProfile ?? "default"}` : "Open work item"}
            </Link>
          ) : (
            <p className="text-muted">No linked task or source chat is available.</p>
          )}
          {r.task ? (
            <div className="cp-provenance">
              <Link className="text-accent underline" href={r.task.href}>
                {r.task.title}
              </Link>
              <CopyValue label="Task ID" value={r.task.id} />
            </div>
          ) : null}
          {r.run ? (
            <div className="cp-provenance">
              <span>Run {r.run.ref}</span>
              <CopyValue label="Run ID" value={r.run.id} />
              {r.run.events?.length ? (
                <ul>
                  {r.run.events.map((event) => (
                    <li key={`${event.at}-${event.summary}`}>
                      {event.type}: {event.summary}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {r.sourceChat ? (
            <Link className="text-accent underline" href={r.sourceChat.href}>
              Open source chat
            </Link>
          ) : null}
          <details className="cp-run-raw">
            <summary>Details and copy{r.titleTruncated ? " · stored source truncated" : ""}</summary>
            <p className="whitespace-pre-wrap break-words">{typeof r.title === "string" && r.title ? r.title : "No stored title or goal."}</p>
            <CopyValue label="Full available brief" value={typeof r.title === "string" ? r.title : ""} />
            {ids.map((id) => (
              <CopyValue key={id} value={id} />
            ))}
            {r.links?.map((l) =>
              safeHref(l.url) ? (
                <a
                  key={l.url}
                  className="block text-accent underline"
                  href={safeHref(l.url)!}
                  target={l.url.startsWith("/") ? undefined : "_blank"}
                  rel="noopener noreferrer"
                >
                  {l.label ?? l.url}
                </a>
              ) : null,
            )}
          </details>
          {r.transcriptPath ? (
            <CopyValue
              label="Transcript path"
              value={r.transcriptPath}
              compact
              copied={copied}
              setCopied={setCopied}
              copyError={copyError}
              setCopyError={setCopyError}
            />
          ) : null}
        </div>
      </details>
    </li>
  );
}
function CopyValue({
  label = "Run ID",
  value,
  compact,
  copied,
  setCopied,
  copyError,
  setCopyError,
}: {
  label?: string;
  value: string;
  compact?: boolean;
  copied?: boolean;
  setCopied?: (value: boolean) => void;
  copyError?: boolean;
  setCopyError?: (value: boolean) => void;
}) {
  const [ownCopied, ownSetCopied] = useState(false);
  const [ownError, ownSetError] = useState(false);
  const done = copied ?? ownCopied;
  const failed = copyError ?? ownError;
  const setDone = setCopied ?? ownSetCopied;
  const setFailed = setCopyError ?? ownSetError;
  return (
    <div className={compact ? "cp-copy cp-copy-compact" : "cp-copy"}>
      <span>{label}</span>
      <code>{value}</code>
      <ChipButton
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() =>
          void (navigator.clipboard?.writeText(value) ?? Promise.reject()).then(
            () => {
              setDone(true);
              setFailed(false);
            },
            () => setFailed(true),
          )
        }
      >
        {done ? "Copied" : "Copy"}
      </ChipButton>
      {failed ? <p role="status">Copy unavailable — select the ID above.</p> : null}
    </div>
  );
}

type Props = {
  sessionId: string;
  open: boolean;
  wide: boolean;
  tab: ThingsTab;
  onTab: (tab: ThingsTab) => void;
  onClose: () => void;
  things: ChatThings;
  links: PanelLink[];
  context: ContextChip[];
  readOnly: boolean;
  onPatch: (b: { url: string; pinned?: boolean; removed?: boolean }) => void;
  onRemoveContext: (ref: string) => void;
  execution?: ChatExecutionResponse;
  executionError?: boolean;
  executionLoading?: boolean;
  retry: () => void;
  onAddContext: () => void;
  pending?: ReactNode;
  workflow?: { run: RunPanelView; target: string | null; onTarget: (field: string | null) => void; capture: AgentCaptureState } | null;
};
const workflowTabs: ThingsTab[] = ["Outline", "Form", "Notes", "Outputs"];
/** The fixed sections of "In this chat", in the order they are always drawn. The tray's chips name them by tab. */
const SECTIONS = ["Running", "Waiting", "PRs", "Artifacts", "Files", "Links", "Context"] as const;
type SectionId = (typeof SECTIONS)[number];
const SECTION_TITLE: Record<SectionId, string> = {
  Running: "Running",
  Waiting: "Waiting on you",
  PRs: "Pull requests",
  Artifacts: "Artifacts",
  Files: "Files",
  Links: "Links",
  Context: "Context",
};
const clamp = (width: number) => Math.max(280, Math.min(480, width));
export function ChatPanel(props: Props) {
  const { open, wide, onClose } = props;
  const [width, setWidth] = useState(360);
  const [full, setFull] = useState(false);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem("jarvis.chat.panel.width"));
      if (saved) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate optional persisted browser preference
        setWidth(clamp(saved));
      }
    } catch {
      /* optional storage */
    }
  }, []);
  const resize = (value: number) => {
    const next = clamp(value);
    setWidth(next);
    try {
      localStorage.setItem("jarvis.chat.panel.width", String(next));
    } catch {
      /* optional storage */
    }
  };
  if (!open) return null;
  const content = <PanelContent {...props} />;
  if (!wide)
    return (
      <ChatSheet onClose={onClose} full={full} onFull={setFull}>
        {content}
      </ChatSheet>
    );
  return (
    <aside className="chat-things-panel" aria-label="In this chat" data-testid="chat-panel" style={{ "--chat-panel-width": `${width}px` } as CSSProperties}>
      <div
        className="chat-panel-resizer"
        role="separator"
        aria-label="Resize chat panel"
        aria-orientation="vertical"
        aria-valuemin={280}
        aria-valuemax={480}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            resize(width + (e.key === "ArrowLeft" ? 20 : -20));
          }
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) resize(e.currentTarget.parentElement!.getBoundingClientRect().right - e.clientX);
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      />
      <header className="flex items-center justify-between gap-2 border-b border-line p-2">
        <h2 className="text-sm font-semibold">In this chat</h2>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Collapse chat panel">
          Collapse
        </Button>
      </header>
      {content}
    </aside>
  );
}
/** One kind of thing in the chat: its name, how many there are, then the things (or one quiet line). */
function PanelSection({ id, uid, count, children }: { id: SectionId; uid: string; count?: number | null; children: ReactNode }) {
  return (
    <section className="cp-sec" aria-labelledby={`${uid}-${id}`} data-section={id}>
      <h3 id={`${uid}-${id}`} className="cp-sec-h">
        {SECTION_TITLE[id]}
        {count != null ? <> </> : null}
        {count != null ? <span className="cp-sec-n">· {count}</span> : null}
      </h3>
      {children}
    </section>
  );
}
const Quiet = ({ children }: { children: ReactNode }) => <p className="cp-quiet">{children}</p>;

/**
 * "In this chat": a fixed place for each kind of thing, always in the same order: running work, what waits on the
 * owner, pull requests, artifacts, files, links and context. An empty kind says so in one quiet line.
 * `p.tab` (what the tray or the header asked for) is brought into view; nothing is hidden behind it.
 */
function ChatSections(p: Props) {
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const wanted: SectionId = (SECTIONS as readonly string[]).includes(p.tab) ? (p.tab as SectionId) : "Running";
  useEffect(() => {
    if (wanted === "Running") return;
    root.current?.querySelector<HTMLElement>(`[data-section="${wanted}"]`)?.scrollIntoView?.({ block: "start" });
  }, [wanted]);
  const records = p.execution?.records ?? [];
  const waiting = records.filter((r) => r.state === "waiting");
  // The link back to a parent chat is drawn once, at the top of the panel.
  const running = p.execution ? { ...p.execution, parent: null, records: records.filter((r) => r.state !== "waiting") } : undefined;
  const prs = p.links.filter((l) => l.kind === "github" && l.ghType === "pull");
  const artifacts = p.links.filter((l) => l.kind === "artifact");
  const others = p.links.filter((l) => l.kind !== "artifact" && !(l.kind === "github" && l.ghType === "pull"));
  const c = p.things.counts;
  const linksProps = { sessionId: p.sessionId, context: p.context, readOnly: p.readOnly, onPatch: p.onPatch, onRemoveContext: p.onRemoveContext };
  return (
    <div ref={root} className="cp-sections">
      <PanelSection id="Running" uid={uid} count={c.running}>
        <RunningSection execution={running} error={p.executionError} loading={p.executionLoading} retry={p.retry} />
      </PanelSection>
      <PanelSection id="Waiting" uid={uid} count={waiting.length + (p.pending ? 1 : 0)}>
        {p.pending}
        {waiting.length ? (
          <ul className="space-y-2">
            {waiting.map((record) => (
              <ExecutionRow key={record.key} record={record} />
            ))}
          </ul>
        ) : null}
        {!p.pending && !waiting.length ? <Quiet>Nothing is waiting on you</Quiet> : null}
      </PanelSection>
      <PanelSection id="PRs" uid={uid} count={prs.length}>
        {prs.length ? (
          <>
            <LinksPanel {...linksProps} links={prs} linksOnly bare />
            {prs.map((l) =>
              l.state === "merged" || isFailingLink(l) ? (
                <p key={l.url} className="mt-2 text-xs text-muted">
                  #{l.number}: {l.state === "merged" ? "Merged · no deploy record. Live status unknown." : `Reported state: ${l.state}`}
                </p>
              ) : null,
            )}
          </>
        ) : (
          <Quiet>None yet</Quiet>
        )}
      </PanelSection>
      <PanelSection id="Artifacts" uid={uid} count={artifacts.length}>
        {/* The same row as a link (open, pin, remove): an artifact is listed once, here. */}
        {artifacts.length ? <LinksPanel {...linksProps} links={artifacts} linksOnly bare /> : <Quiet>None yet</Quiet>}
      </PanelSection>
      <PanelSection id="Files" uid={uid} count={c.files}>
        <FilesSection sessionId={p.sessionId} bare />
      </PanelSection>
      <PanelSection id="Links" uid={uid} count={others.length}>
        {others.length ? <LinksPanel {...linksProps} links={others} linksOnly bare /> : <Quiet>None yet</Quiet>}
      </PanelSection>
      <PanelSection id="Context" uid={uid}>
        {c.context != null ? <p className="text-sm text-muted">{c.context}% context used</p> : null}
        <LinksPanel {...linksProps} links={[]} contextOnly bare />
        <Button size="sm" onClick={p.onAddContext}>
          Add context
        </Button>
      </PanelSection>
    </div>
  );
}

function PanelContent(p: Props) {
  const id = useId();
  // A workflow chat keeps its own tabs (Outline, Form, Notes, Outputs); everything of the chat itself is one more.
  const inChat = !workflowTabs.includes(p.tab);
  const tabs: { id: ThingsTab; label?: string }[] = [...workflowTabs.map((tab) => ({ id: tab })), { id: "Links", label: "In this chat" }];
  const selected: ThingsTab = inChat ? "Links" : p.tab;
  if (!p.workflow)
    return (
      <div className="chat-panel-content p-3" data-testid="chat-panel-content">
        <ParentChatLink parent={p.execution?.parent} />
        <ChatSections {...p} />
      </div>
    );
  const navigation = (
    <>
      <div role="tablist" aria-label="Chat panel tabs" className="flex flex-wrap gap-1 border-b border-line py-2">
        {tabs.map((tab, index) => (
          <SummaryChip
            key={tab.id}
            kind={tab.id}
            role="tab"
            id={`${id}-${tab.id}`}
            aria-controls={`${id}-body-${tab.id}`}
            aria-selected={selected === tab.id}
            tabIndex={selected === tab.id ? 0 : -1}
            onClick={() => p.onTab(tab.id)}
            onKeyDown={(e) => {
              let next: number;
              if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (e.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = tabs.length - 1;
              else return;
              e.preventDefault();
              p.onTab(tabs[next].id);
              document.getElementById(`${id}-${tabs[next].id}`)?.focus();
            }}
          >
            {tab.label}
          </SummaryChip>
        ))}
      </div>
      {tabs
        .filter((tab) => tab.id !== selected)
        .map((tab) => (
          <div key={tab.id} role="tabpanel" id={`${id}-body-${tab.id}`} aria-labelledby={`${id}-${tab.id}`} hidden />
        ))}
    </>
  );
  return (
    <div className="chat-panel-content p-3" data-testid="chat-panel-content">
      {inChat ? <ParentChatLink parent={p.execution?.parent} /> : null}
      <RunPanel
        sessionId={p.sessionId}
        {...p.workflow}
        section={selected}
        navigation={navigation}
        bodyId={`${id}-body-${selected}`}
        labelledBy={`${id}-${selected}`}
      >
        {inChat ? (
          <div className="pt-3">
            <ChatSections {...p} />
          </div>
        ) : null}
      </RunPanel>
    </div>
  );
}
