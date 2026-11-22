"use client";

/**
 * Sections of a task's Overview that the conversation feeds (task threads, step 1): the status bar at the bottom,
 * the decisions on the task (open and made), and what its chat made or linked. The chat's own "In this chat" sheet
 * reads the same data under the same query keys, so the two never disagree.
 */
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChevronIcon } from "@/components/icons";
import { Button, Pill, RefPill, StateDot, StateWord, useNow } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { ChatFileView } from "@/lib/chat-files";
import type { Decision } from "@/lib/cw-decisions";
import { ageLabel } from "@/lib/coordinator/needs";
import { coordHref } from "@/lib/item-page";
import type { WorkState } from "@/lib/work-words";
import type { PanelLink } from "@/server/chat/links";
import "./task-chat.css";

/** What the bar says: the state in the shared words, then what it is about. */
export type TaskStatus = { state: WorkState; text: string };

/**
 * The status bar at the bottom of a task's Overview: one line for what is happening on the task. A tap opens Chat,
 * where the same line sits above the composer. Nothing is drawn while nothing is happening.
 */
export function TaskStatusBar({ status, onOpen }: { status: TaskStatus | null; onOpen: () => void }) {
  if (!status) return null;
  return (
    <div className="task-status" data-testid="task-status">
      <Button variant="ghost" className="task-status-line" onClick={onOpen} aria-label={`${status.text}. Open chat`} data-density-skip>
        <StateDot state={status.state} />
        <strong>
          <StateWord state={status.state} />
        </strong>
        <span className="task-status-text">{status.text}</span>
        <ChevronIcon className="task-status-chev h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/** Every decision on the task, open first, then the ones made (newest first). */
export function useTaskDecisions(itemId: string, enabled = true) {
  return useQuery({
    queryKey: ["work", "coordinator", "decisions", "all"],
    queryFn: ({ signal }) => api.get<{ decisions: Decision[] }>("/api/coordinator/decisions?state=all", signal),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    select: (r) =>
      r.decisions
        .filter((x) => x.itemId === itemId && (x.state === "open" || x.state === "answered" || x.state === "defaulted"))
        .sort((a, b) => Number(b.state === "open") - Number(a.state === "open") || b.createdAt.localeCompare(a.createdAt)),
  });
}

/** Decisions: the questions asked on this task and what was chosen. An open one opens where it is answered. */
export function TaskDecisions({ itemId, decisions }: { itemId: string; decisions: readonly Decision[] }) {
  const router = useRouter();
  const now = useNow();
  if (!decisions.length) return null;
  return (
    <section className="ip-sec" aria-labelledby="ip-decisions-h" data-testid="item-decisions">
      <h3 id="ip-decisions-h" className="ip-label">
        Decisions <span className="ip-count">· {decisions.length}</span>
      </h3>
      <ul className="ip-decisions">
        {decisions.map((x) => {
          const open = x.state === "open";
          return (
            <li key={x.id} className="ip-decision" data-open={open || undefined}>
              <RefPill id={x.ref} onClick={open ? () => router.push(coordHref(itemId, "needs", x.ref)) : undefined} />
              <span className="ip-decision-q">
                {x.question}
                {x.answeredChoice ? <b>: {x.answeredChoice}</b> : null}
              </span>
              <span className="ip-decision-at" data-dynamic>
                {open ? "open" : ageLabel(x.answeredAt ?? x.updatedAt, now)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export type ChatMade = { key: string; kind: "Pull request" | "Issue" | "Artifact" | "Link" | "File"; title: string; href: string | null; note: string };

const linkKindOf = (l: PanelLink): ChatMade["kind"] =>
  l.kind === "artifact" ? "Artifact" : l.kind === "github" ? (l.ghType === "pull" ? "Pull request" : l.ghType === "issue" ? "Issue" : "Link") : "Link";
const fileSize = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * What the task's chat made or linked (pull requests, artifacts, links, files sent in it), read under the query
 * keys the chat's own panel uses. `skip` holds the URLs the task already lists itself.
 */
export function useChatMade(sessionId: string | null, skip: ReadonlySet<string>, enabled = true): ChatMade[] {
  const on = !!sessionId && enabled;
  const links = useQuery({
    queryKey: ["chat-links", sessionId],
    queryFn: () => api.get<{ links: PanelLink[] }>(`/api/hermes/sessions/${encodeURIComponent(sessionId!)}/links-panel`),
    enabled: on,
    staleTime: 15_000,
  });
  const files = useQuery({
    queryKey: ["chat-files", sessionId],
    queryFn: () => api.get<{ files: ChatFileView[] }>(`/api/hermes/sessions/${encodeURIComponent(sessionId!)}/files`).then((r) => r.files),
    enabled: on,
    staleTime: 30_000,
  });
  if (!on) return [];
  const rank: Record<ChatMade["kind"], number> = { "Pull request": 0, Issue: 1, Artifact: 2, File: 3, Link: 4 };
  return [
    ...(links.data?.links ?? [])
      .filter((l) => !skip.has(l.url))
      .map((l): ChatMade => ({
        key: l.url,
        kind: linkKindOf(l),
        title: l.title || l.url,
        href: l.url,
        note: [l.state, l.pinned ? "pinned" : ""].filter(Boolean).join(" · "),
      })),
    ...(files.data ?? [])
      .filter((f) => f.sentAt)
      .map((f): ChatMade => ({ key: `file:${f.id}`, kind: "File", title: f.name, href: null, note: fileSize(f.bytes) })),
  ].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** Rows for what the chat made, in the task page's link-row shape. */
export function ChatMadeRows({ made }: { made: readonly ChatMade[] }) {
  return (
    <>
      {made.map((m) => (
        <li key={m.key} className="ip-linkrow" data-testid="made-row" data-kind={m.kind}>
          <div className="ip-linkrow-main">
            <p className="ip-linkrow-t">
              <Pill tone={m.kind === "Pull request" || m.kind === "Issue" ? "ac" : m.kind === "Link" ? "neutral" : "inf"}>{m.kind}</Pill>
              {m.href ? (
                <a href={m.href} target="_blank" rel="noreferrer noopener" className="ip-linkrow-name" aria-label={`Open: ${m.title} (opens in a new tab)`}>
                  {m.title}
                </a>
              ) : (
                <span className="ip-linkrow-name">{m.title}</span>
              )}
            </p>
            <p className="ip-linkrow-s">
              <span>{["from the chat", m.note].filter(Boolean).join(" · ")}</span>
            </p>
          </div>
        </li>
      ))}
    </>
  );
}
