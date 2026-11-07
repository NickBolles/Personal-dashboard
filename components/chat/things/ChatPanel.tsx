"use client";
import Link from "next/link";
import { useEffect, useId, useState, type ReactNode, type CSSProperties } from "react";
import { Badge, Button, Spinner } from "@/components/ui";
import { BrainIcon, ForkIcon, ToolIcon } from "@/components/icons";
import { safeHref } from "@/components/markdown/Markdown";
import { isActiveExec, type ChatExecutionResponse, type ExecutionRecord } from "@/lib/chat-execution";
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
  const groups = [
    { title: "Running", records: records.filter(isActiveExec) },
    { title: "Finished", records: records.filter((r) => ["completed", "failed", "cancelled"].includes(r.state)) },
    { title: "Status unknown", records: records.filter((r) => r.state === "unknown") },
  ];
  return (
    <div className="space-y-3 text-sm" data-testid="chat-running">
      <ParentChatLink parent={execution?.parent} />
      {pending}
      {loading && !execution ? <Spinner label="Loading agents and jobs…" /> : null}
      {error || (!loading && !execution) || execution?.sources.length === 0 ? (
        <p className="text-xs text-muted" role="status">
          Couldn&apos;t load execution status.{" "}
          <Button size="sm" onClick={retry}>
            Retry
          </Button>
        </p>
      ) : null}
      {execution?.sources
        .filter((s) => s.state !== "ok")
        .map((s) => (
          <div key={s.source} className="rounded-lg border border-line p-2 text-xs text-muted" role="status">
            Couldn&apos;t load {s.source.replaceAll("_", " ")}
            {s.state === "stale" ? " · saved status may be stale" : " · source unavailable"}
            {s.detail ? `: ${s.detail}` : ""}.{" "}
            <Button size="sm" onClick={retry}>
              Retry
            </Button>
          </div>
        ))}
      {groups
        .filter((g) => g.records.length)
        .map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h3 className="mb-1 text-xs font-semibold text-muted">{g.title}</h3>
            <ul className="space-y-2">
              {g.records.map((record) => (
                <ExecutionRow key={record.key} record={record} />
              ))}
            </ul>
          </section>
        ))}
      {!records.length && allOk ? <p className="text-muted">No agents or jobs for this chat</p> : null}
    </div>
  );
}
function ExecutionRow({ record: r }: { record: ExecutionRecord }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const Icon = r.source === "process" ? ToolIcon : r.source === "fork" ? ForkIcon : BrainIcon;
  const seconds = r.startedAt && r.endedAt ? (Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000 : null;
  return (
    <li className="rounded-lg border border-line p-2">
      <details>
        <summary className="min-h-11 cursor-pointer sm:min-h-10 dense:min-h-8">
          <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
            <Icon className="h-4 w-4 shrink-0" />
            <strong className="break-words font-medium">{r.title}</strong>
            <Badge tone={r.state === "failed" ? "danger" : r.state === "completed" ? "ok" : r.state === "waiting" ? "warn" : "neutral"}>{r.state}</Badge>
          </span>
          <span className="block text-xs text-muted">
            {r.source.replaceAll("_", " ")}
            {r.startedAt ? (
              <>
                {" "}
                ·{" "}
                <time dateTime={r.startedAt} title={r.startedAt}>
                  Started {relativeTime(r.startedAt)}
                </time>
              </>
            ) : null}
            {seconds != null && Number.isFinite(seconds) && seconds >= 0 ? ` · ${Math.round(seconds)}s elapsed` : ""}
          </span>
          {r.step ? <span className="block text-xs text-muted">{r.step}</span> : null}
          {r.progress != null && Number.isFinite(r.progress) ? (
            <progress className="mt-1 w-full accent-accent" max={1} value={Math.min(1, Math.max(0, r.progress))} aria-label={`${r.title} progress`} />
          ) : null}
        </summary>
        <div className="mt-2 space-y-2 break-words text-xs">
          {r.summary ? <p className="whitespace-pre-wrap">{r.summary}</p> : null}
          {r.error ? <p className="whitespace-pre-wrap text-danger">{r.error}</p> : null}
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
          {r.transcriptPath ? (
            <div>
              <span className="text-muted">Transcript: </span>
              <code className="break-all select-text">{r.transcriptPath}</code>
              <Button
                size="sm"
                onClick={() => {
                  void (navigator.clipboard?.writeText(r.transcriptPath!) ?? Promise.reject()).then(
                    () => {
                      setCopied(true);
                      setCopyError(false);
                    },
                    () => setCopyError(true),
                  );
                }}
              >
                {copied ? "Copied" : "Copy transcript path"}
              </Button>
              {copyError ? <p role="status">Couldn&apos;t copy. Select the path to copy it.</p> : null}
            </div>
          ) : null}
        </div>
      </details>
      {r.href && internalHref(r.href) ? (
        <Link className="inline-flex min-h-11 items-center gap-1 text-xs text-accent underline sm:min-h-10 dense:min-h-8" href={r.href}>
          {r.childSessionId ? "Open child chat" : "Open work item"}
          {r.childSessionId ? ` · @${r.childProfile ?? "default"}` : ""}
        </Link>
      ) : null}
    </li>
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
const chatTabs: ThingsTab[] = ["Links", "Artifacts", "PRs", "Running", "Files", "Context"];
const workflowTabs: ThingsTab[] = ["Outline", "Form", "Notes", "Outputs"];
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
      <ChatSheet onClose={onClose} full={full} onFull={() => setFull(!full)}>
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
function PanelContent(p: Props) {
  const id = useId();
  const tabs = p.workflow ? [...workflowTabs, ...chatTabs] : chatTabs;
  const selected = tabs.includes(p.tab) ? p.tab : "Links";
  const count = (tab: ThingsTab): number | null | undefined => {
    const c = p.things.counts;
    return (
      { Links: c.links, Artifacts: c.artifacts, PRs: c.prs.total, Running: c.running, Files: c.files, Context: c.context } as Partial<
        Record<ThingsTab, number | null>
      >
    )[tab];
  };
  const navigation = (
    <>
      <div role="tablist" aria-label="Chat panel tabs" className="flex flex-wrap gap-1 border-b border-line py-2">
        {tabs.map((tab, index) => (
          <SummaryChip
            key={tab}
            kind={tab}
            count={count(tab)}
            role="tab"
            id={`${id}-${tab}`}
            aria-controls={`${id}-body-${tab}`}
            aria-selected={selected === tab}
            tabIndex={selected === tab ? 0 : -1}
            tone={tab === "PRs" && p.things.counts.prs.failing ? "bad" : "neutral"}
            onClick={() => p.onTab(tab)}
            onKeyDown={(e) => {
              let next: number;
              if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (e.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = tabs.length - 1;
              else return;
              e.preventDefault();
              p.onTab(tabs[next]);
              document.getElementById(`${id}-${tabs[next]}`)?.focus();
            }}
          />
        ))}
      </div>
      {tabs
        .filter((tab) => tab !== selected)
        .map((tab) => (
          <div key={tab} role="tabpanel" id={`${id}-body-${tab}`} aria-labelledby={`${id}-${tab}`} hidden />
        ))}
    </>
  );
  const linksProps = {
    sessionId: p.sessionId,
    links: p.links,
    context: p.context,
    readOnly: p.readOnly,
    onPatch: p.onPatch,
    onRemoveContext: p.onRemoveContext,
  };
  const body = (
    <>
      {selected === "Links" ? <LinksPanel {...linksProps} /> : null}
      {selected === "Artifacts" ? (
        <div className="grid grid-cols-2 gap-2">
          {p.links
            .filter((l) => l.kind === "artifact")
            .map((l) => (
              <a
                href={safeHref(l.url) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                key={l.url}
                className="min-h-11 rounded-lg border border-line bg-surface-2 p-3 text-sm break-words"
              >
                <strong>{l.title}</strong>
                <span className="mt-1 block text-xs text-muted">Artifact · {l.slug} ↗</span>
              </a>
            ))}
          {!p.things.counts.artifacts ? <p className="col-span-2 text-sm text-muted">No artifacts in this chat yet.</p> : null}
        </div>
      ) : null}
      {selected === "PRs" ? (
        <>
          <LinksPanel {...linksProps} links={p.links.filter((l) => l.kind === "github" && l.ghType === "pull")} linksOnly />
          {p.links
            .filter((l) => l.ghType === "pull")
            .map((l) =>
              l.state === "merged" || isFailingLink(l) ? (
                <p key={l.url} className="mt-2 text-xs text-muted">
                  #{l.number}: {l.state === "merged" ? "Merged · no deploy record. Live status unknown." : `Reported state: ${l.state}`}
                </p>
              ) : null,
            )}
        </>
      ) : null}
      {selected === "Running" ? (
        <RunningSection execution={p.execution} error={p.executionError} loading={p.executionLoading} retry={p.retry} pending={p.pending} />
      ) : null}
      {selected === "Files" ? <FilesSection sessionId={p.sessionId} /> : null}
      {selected === "Context" ? (
        <section className="space-y-3 text-sm">
          <h3 className="font-semibold">Context & usage</h3>
          <p className="text-muted">{p.things.counts.context == null ? "Context usage unavailable" : `${p.things.counts.context}% context used`}</p>
          <p className="text-xs text-muted">Token and cost breakdown unavailable.</p>
          <LinksPanel {...linksProps} contextOnly />
          <Button onClick={p.onAddContext}>Add context</Button>
          <p className="text-xs text-muted">Areas excluded from AI are never sent.</p>
        </section>
      ) : null}
    </>
  );
  return (
    <div className="chat-panel-content p-3" data-testid="chat-panel-content">
      {selected !== "Running" ? <ParentChatLink parent={p.execution?.parent} /> : null}
      {p.workflow ? (
        <RunPanel
          sessionId={p.sessionId}
          {...p.workflow}
          section={selected}
          navigation={navigation}
          bodyId={`${id}-body-${selected}`}
          labelledBy={`${id}-${selected}`}
        >
          <div className="pt-3">{body}</div>
        </RunPanel>
      ) : (
        <>
          {navigation}
          <div role="tabpanel" id={`${id}-body-${selected}`} aria-labelledby={`${id}-${selected}`} className="pt-3">
            {body}
          </div>
        </>
      )}
    </div>
  );
}
