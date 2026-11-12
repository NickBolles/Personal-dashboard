"use client";

import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AgentMark } from "@/components/brand/AgentMark";
import { LiveState, useAgentRuns } from "@/components/agents/AgentRuns";
import { Button, ButtonLink, Pill, ProgressBar, useNow, type KTone } from "@/components/ui";
import { AlertIcon, AreasIcon, ChatIcon, ChevronIcon, ClockIcon, ExternalIcon, InboxIcon } from "@/components/icons";
import type { ActivityItem } from "@/lib/activity";
import { CHECKS_LABEL, DEPLOY_LABEL, whoLabel, type ItemAgentInfo, type PrState } from "@/lib/agent-runs";
import { api } from "@/lib/client/api";
import type { Decision } from "@/lib/cw-decisions";
import { changeChip, changeText, itemCardModel } from "@/lib/coordinator/item-card";
import { eventClock, runStatus } from "@/lib/coordinator/run-card";
import type { CoordinatorRunRow } from "@/lib/coordinator/runs-view";
import { relativeTime } from "@/lib/time";
import type { ItemsResponse, WorkItem } from "@/lib/work";
import { useCoordinatorDecisions } from "../needs/useCoordinatorDecisions";
import { StatusChip } from "../running/RunCard";
import { useCoordinatorRuns } from "../running/useCoordinatorRuns";
import "../running/run-card.css";

/** How many changes a card lists before "N earlier". */
const CHANGES_SHOWN = 3;

export type ItemCardData = {
  items: readonly WorkItem[];
  agents: Record<string, ItemAgentInfo>;
  runs: readonly CoordinatorRunRow[];
  decisions: readonly Decision[];
};
/**
 * Everything an item card reads, from the queries the app already keeps warm (items, agent runs, R-n runs, D-n
 * decisions). While cards are on screen the tree is refreshed every 30 s; the others poll on their own.
 */
export function useItemCardData(enabled = true): ItemCardData {
  const items = useQuery({
    queryKey: ["work", "items", false],
    queryFn: () => api.get<ItemsResponse>("/api/work/items"),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
  });
  const agents = useAgentRuns(enabled);
  const runs = useCoordinatorRuns(false, enabled);
  const decisions = useCoordinatorDecisions();
  return { items: items.data?.items ?? [], agents: agents.data?.items ?? {}, runs: runs.data?.runs ?? [], decisions: decisions.data?.decisions ?? [] };
}

const PR_TONE = (p: PrState): KTone => (p.state === "merged" ? "ai" : p.state === "closed" ? "neutral" : "ac");
const CHECK_TONE: Record<string, KTone> = { success: "ok", failure: "bad", pending: "wn" };
function PrLine({ pr }: { pr: PrState }) {
  const name = pr.title || pr.ref;
  return (
    <li className="ic-pr">
      {pr.url && /^https:\/\//i.test(pr.url) ? (
        <a href={pr.url} target="_blank" rel="noreferrer noopener" className="ic-pr-name">
          {name}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <span className="ic-pr-name">{name}</span>
      )}
      <span className="ic-pr-pills">
        <Pill tone={PR_TONE(pr)}>{pr.state ? pr.state[0]!.toUpperCase() + pr.state.slice(1) : "Not read yet"}</Pill>
        {pr.checks ? <Pill tone={CHECK_TONE[pr.checks] ?? "neutral"}>{CHECKS_LABEL[pr.checks] ?? pr.checks}</Pill> : null}
        {pr.deploy ? <Pill tone={pr.deploy === "live" ? "ok" : "wn"}>{DEPLOY_LABEL[pr.deploy]}</Pill> : null}
      </span>
    </li>
  );
}

export type ItemCardProps = {
  itemId: string;
  /** Shown until (or instead of) the item itself: an activity row always knows its item's title. */
  title: string;
  data: ItemCardData;
  /** What was done to it, newest first. Each row keeps its own Undo. */
  changes?: readonly ActivityItem[];
  undo?: (row: ActivityItem) => ReactNode;
  /** Jump to a decision (D-n) or a run (R-n) in the panel. */
  onRef?: (ref: string) => void;
  /** Start a question about this item in the chat. */
  onAsk?: (title: string) => void;
  defaultOpen?: boolean;
};

/**
 * One item or project, readable at a glance: the state that matters now (a decision waiting on you, a run that
 * failed or went quiet, an agent working, else its own status), where it sits, what is next and when it is due,
 * who is on it, progress and pull requests, and what was just changed. Chips jump to the decision or run;
 * opening the card adds its summary, the last agent report and what you can do with it.
 */
export function ItemCard({ itemId, title, data, changes = [], undo, onRef, onAsk, defaultOpen = false }: ItemCardProps) {
  const now = useNow();
  const [open, setOpen] = useState(defaultOpen);
  const [allChanges, setAllChanges] = useState(false);
  const detailId = useId();
  const item = data.items.find((i) => i.id === itemId);
  const agent = data.agents[itemId] ?? null;
  const model = item ? itemCardModel({ item, items: data.items, agent, runs: data.runs, decisions: data.decisions, now }) : null;
  const shown = allChanges ? changes : changes.slice(0, CHANGES_SHOWN);
  const hidden = changes.length - shown.length;
  const href = `/areas?item=${encodeURIComponent(itemId)}`;
  const name = model?.title ?? title;
  // An area's standing coordinator is on everything under it: only worth a line when it (or anyone) is actually working.
  const busy = !!agent && agent.live !== "idle";
  const who = agent?.who && (busy || agent.who.kind !== "coordinator") ? agent.who : null;
  const prs = agent?.prs ?? [];
  const meta = model
    ? [model.path.join(" › "), model.headline.key === "status" ? "" : model.status.label, ...model.tags.slice(0, 3).map((t) => `#${t}`)].filter(Boolean)
    : [];
  return (
    <article className="rc ic" data-item={itemId} data-state={model?.headline.key ?? "unknown"} data-open={open || undefined}>
      <Button variant="ghost" className="gc-run-body rc-head" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((value) => !value)}>
        <span className="rc-top">
          {model ? (
            <StatusChip
              tone={model.headline.tone}
              live={model.headline.live}
              label={model.headline.label}
              detail={`updated ${relativeTime(model.updatedAt, now)}`}
            />
          ) : (
            <span className="rc-status" />
          )}
          {model ? <span className="rc-ref">{model.kind}</span> : null}
          <ChevronIcon className={`rc-chevron h-4 w-4 ${open ? "-rotate-90" : "rotate-90"}`} />
        </span>
        <span className="rc-title line-clamp-2">{name}</span>
        {meta.length ? (
          <span className="rc-meta">
            {meta.map((part) => (
              <span key={part}>{part}</span>
            ))}
          </span>
        ) : null}
      </Button>
      {model?.next || model?.due ? (
        <p className="ic-next">
          {model.next ? (
            <span className="ic-next-text">
              <span className="ic-label">Next</span>
              {model.next}
            </span>
          ) : null}
          {model.due ? (
            <Pill tone={model.due.tone} className="ic-due">
              <ClockIcon className="h-3 w-3" />
              {model.due.label}
            </Pill>
          ) : null}
        </p>
      ) : null}
      {who || busy ? (
        <p className="ic-agent">
          {who ? <AgentMark name={who.kind === "person" ? null : who.name} busy={agent?.live === "running"} /> : null}
          {who ? <span className="ic-who">{whoLabel(who)}</span> : null}
          {agent && busy ? <LiveState live={agent.live} at={agent.liveAt} approval={agent.approval} /> : null}
        </p>
      ) : null}
      {model?.progress && model.progress.total ? (
        <div className="ic-progress">
          <ProgressBar value={(model.progress.done / model.progress.total) * 100} tone="orb" label={`${model.progress.done} of ${model.progress.total} done`} />
          <span data-dynamic>
            {model.progress.done} of {model.progress.total} done
          </span>
        </div>
      ) : null}
      {model && (model.decisions.length || model.attention.length || model.working.length) ? (
        <div className="ic-jumps">
          {model.decisions.slice(0, 2).map((d) => (
            <Button
              key={d.id}
              variant="ghost"
              size="sm"
              className="rc-jump k-t-wn"
              icon={<InboxIcon className="h-3.5 w-3.5" />}
              disabled={!onRef}
              aria-label={`Decision ${d.ref.replace("-", " ")}: ${d.question.slice(0, 80)}`}
              onClick={() => onRef?.(d.ref)}
            >
              {d.ref} needs you
            </Button>
          ))}
          {model.decisions.length > 2 ? <span className="ic-more">+{model.decisions.length - 2} more</span> : null}
          {[...model.attention, ...model.working].slice(0, 2).map((r) => {
            const status = runStatus(r, now);
            return (
              <Button
                key={r.id}
                variant="ghost"
                size="sm"
                className={`rc-jump k-t-${status.tone}`}
                icon={status.attention ? <AlertIcon className="h-3.5 w-3.5" /> : undefined}
                disabled={!onRef}
                aria-label={`Run ${r.ref.replace("-", " ")}: ${status.label}, ${r.title.slice(0, 80)}`}
                onClick={() => onRef?.(r.ref)}
              >
                {r.ref} {status.label.toLowerCase()}
              </Button>
            );
          })}
          {model.attention.length + model.working.length > 2 ? (
            <span className="ic-more">+{model.attention.length + model.working.length - 2} runs</span>
          ) : null}
        </div>
      ) : null}
      {prs.length ? (
        <ul className="ic-prs" aria-label="Pull requests">
          {(open ? prs : prs.slice(0, 1)).map((pr, index) => (
            <PrLine key={`${pr.ref}:${index}`} pr={pr} />
          ))}
        </ul>
      ) : null}
      {shown.length ? (
        <ol className="rc-timeline" aria-label={`Changes to ${name}`}>
          {shown.map((row, index) => {
            const chip = changeChip(row);
            return (
              <li key={row.id} className={`rc-event k-t-${chip.tone}`} data-latest={index === 0 || undefined}>
                <span className="rc-node" aria-hidden="true" />
                <span className="rc-event-main">
                  <Pill tone={chip.tone} className="rc-event-chip">
                    {chip.label}
                  </Pill>
                  {changeText(row) ? <span className="rc-event-text">{changeText(row)}</span> : null}
                </span>
                <span className="ic-change-side">
                  <time className="rc-event-time" dateTime={row.at} title={new Date(row.at).toLocaleString()} data-dynamic>
                    {eventClock(row.at, now)}
                  </time>
                  {undo?.(row)}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {hidden > 0 || allChanges ? (
        <Button size="sm" variant="ghost" className="rc-earlier" aria-expanded={allChanges} onClick={() => setAllChanges((value) => !value)}>
          {allChanges ? "Show fewer" : hidden === 1 ? "1 earlier change" : `${hidden} earlier changes`}
        </Button>
      ) : null}
      {open ? (
        <div className="rc-more" id={detailId}>
          {model?.summary ? <p className="rc-summary line-clamp-4">{model.summary}</p> : null}
          {agent?.report ? (
            <p className="ic-report">
              <span className="ic-report-head">
                <span className="ic-label">Last report</span>
                <span className="rc-event-time" data-dynamic>
                  {relativeTime(agent.report.at, now)}
                </span>
              </span>
              <span>
                {agent.report.title}
                {agent.report.summary ? `: ${agent.report.summary}` : ""}
              </span>
            </p>
          ) : null}
          {!model ? <p className="rc-note">This item is no longer in your areas; its changes are kept here.</p> : null}
          <div className="rc-actions">
            {model ? (
              <ButtonLink size="sm" variant="ghost" className="rc-act" href={href} icon={<AreasIcon className="h-3.5 w-3.5" />}>
                Open {model.container ? model.kind.toLowerCase() : "item"}
              </ButtonLink>
            ) : null}
            {onAsk ? (
              <Button
                size="sm"
                variant="ghost"
                className="rc-act"
                icon={<ChatIcon className="h-3.5 w-3.5" />}
                aria-label={`Ask about ${name}`}
                onClick={() => onAsk(name)}
              >
                Ask
              </Button>
            ) : null}
            {agent?.sessionId ? (
              <ButtonLink
                size="sm"
                variant="ghost"
                className="rc-act"
                href={`/chat/${encodeURIComponent(agent.sessionId)}`}
                icon={<ExternalIcon className="h-3.5 w-3.5" />}
              >
                Agent conversation
              </ButtonLink>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}
