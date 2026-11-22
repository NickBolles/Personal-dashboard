"use client";

/**
 * A task's Chat tab (task threads, step 1): the task's ONE primary chat as the shared thread (ChatThread), its
 * other chats under "Other chats" (any of them can be made primary), and, while the task has no chat yet, a
 * composer whose first message creates it. Nothing is created before there is a message to put in it.
 */
import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChatThread } from "@/components/chat/ChatThread";
import { Composer } from "@/components/chat/Composer";
import { useChatAttachments } from "@/components/chat/Attachments";
import { NodeAgentChip, useNodeAgent } from "@/components/agents/NodeAgentChip";
import { Button, Dialog, Disclosure, useOnline, useToast } from "@/components/ui";
import { useWorkMutation } from "@/components/work/common";
import type { UndoOp } from "@/components/work/UndoBar";
import { api } from "@/lib/client/api";
import { setFirstRun } from "@/lib/client/first-run";
import { refreshSessionLists } from "@/lib/client/session-lists";
import { answererName } from "@/lib/chat/display";
import type { RunView } from "@/lib/hermes";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { taskChats, type TaskChat as TaskChatRow } from "@/lib/task-chat";
import { relativeTime } from "@/lib/time";
import { STATUS_LABELS, type WorkDetail, type WorkEvent, type WorkItem, type WorkStatus } from "@/lib/work";
import "./task-chat.css";

const NO_COMMANDS = [] as const;

/** What a row under "Other chats" says about where the chat comes from. */
const SOURCE_NOTE: Record<TaskChatRow["source"], string> = { filed: "filed here", linked: "linked", recorded: "" };

/**
 * "Other chats": the task's chats that are not its primary one, newest first, each with Make primary (confirmed,
 * with Undo), then the chats agent runs on this task happened in that are not this task's (a coordinator's own
 * chat): those are only linked to, never promoted.
 */
export function OtherChats({
  item,
  others,
  startedIn,
  onOp,
}: {
  item: Pick<WorkItem, "id" | "title">;
  others: TaskChatRow[];
  /** Sessions that agent runs on this task name and that are not one of its chats. */
  startedIn: string[];
  onOp: (op: UndoOp | null | undefined) => void;
}) {
  const [asking, setAsking] = useState<TaskChatRow | null>(null);
  const promote = useWorkMutation(
    (sessionId: string) => api.post<{ item: WorkItem; op: UndoOp | null }>(`/api/work/items/${encodeURIComponent(item.id)}/chat/primary`, { sessionId }),
    {
      onSuccess: (r) => {
        setAsking(null);
        onOp(r.op);
      },
    },
  );
  const count = others.length + startedIn.length;
  if (!count) return null;
  return (
    <>
      <Disclosure summary="Other chats" meta={String(count)} className="tc-others" testId="task-other-chats">
        <ul className="tc-list">
          {others.map((c) => (
            <li key={c.sessionId} className="tc-row">
              <Link href={`/chat/${encodeURIComponent(c.sessionId)}`} className="tc-link">
                {c.title || "Chat"}
              </Link>
              <span className="tc-note">{[SOURCE_NOTE[c.source], c.at ? relativeTime(c.at) : ""].filter(Boolean).join(" · ")}</span>
              <Button size="sm" variant="ghost" onClick={() => setAsking(c)}>
                Make primary
              </Button>
            </li>
          ))}
          {startedIn.map((sessionId) => (
            <li key={sessionId} className="tc-row">
              <Link href={`/chat/${encodeURIComponent(sessionId)}`} className="tc-link">
                Started in another chat
              </Link>
              <span className="tc-note">also used for other work</span>
            </li>
          ))}
        </ul>
      </Disclosure>
      <Dialog
        open={!!asking}
        onClose={() => setAsking(null)}
        title="Make this the primary chat?"
        description={`“${asking?.title || "Chat"}” becomes the chat of ${item.title}. The current one moves to Other chats. You can undo this.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(null)} data-autofocus>
              Cancel
            </Button>
            <Button variant="primary" loading={promote.isPending} onClick={() => asking && promote.mutate(asking.sessionId)}>
              Make primary
            </Button>
          </>
        }
      />
    </>
  );
}

/** The sessions agent runs on a task name that are not one of the task's own chats. */
export function startedElsewhere(d: Parameters<typeof taskChats>[0], runSessions: readonly (string | null | undefined)[]): string[] {
  const chats = taskChats(d);
  const own = new Set([chats.primary?.sessionId, ...chats.others.map((c) => c.sessionId)]);
  return [...new Set(runSessions.filter((s): s is string => !!s && !own.has(s)))];
}

/** A draft for the task's composer. `handoff`: it is a work packet's handoff, recorded on the task when it is sent. */
export type TaskDraft = { text: string; at: number; handoff?: boolean };

const DRAFTS: Record<string, string> = {
  retry: "Try again from where it failed.",
  resume: "Carry on from where you stopped.",
};

/** What a list row opened the task with: Steer (`?compose=1`, an empty draft that takes the cursor), Retry or Resume. */
export function draftFromUrl(): TaskDraft | undefined {
  if (typeof window === "undefined") return undefined;
  const q = new URLSearchParams(window.location.search);
  const text = DRAFTS[q.get("draft") ?? ""];
  if (text) return { text, at: Date.now() };
  return q.get("compose") === "1" ? { text: "", at: Date.now() } : undefined;
}

export function TaskChat({
  d,
  scroll,
  runSessions = [],
  prefill,
  onOp,
}: {
  d: WorkDetail;
  /** window: the page scrolls (a phone pane). element: the thread scrolls in its docked column. */
  scroll: "window" | "element";
  /** The sessions agent runs on this task name (lib/agent-runs ExternalRun.hermesSessionId). */
  runSessions?: readonly (string | null | undefined)[];
  /** A draft to put in the composer (a work packet's handoff, or a row's Steer / Retry / Resume). */
  prefill?: TaskDraft;
  onOp: (op: UndoOp | null | undefined) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const chats = taskChats(d);
  const lead = <OtherChats item={d.item} others={chats.others} startedIn={startedElsewhere(d, runSessions)} onOp={onOp} />;
  if (!chats.primary) return <FirstMessage d={d} scroll={scroll} lead={lead} prefill={prefill} />;
  return (
    <ChatThread
      key={chats.primary.sessionId}
      sessionId={chats.primary.sessionId}
      frame="embedded"
      scroll={scroll}
      lead={lead}
      prefill={prefill}
      onForked={(session) => {
        // The fork is filed under this task as another chat; this one stays primary.
        toast(`Fork created: “${session.title}”. It is under Other chats.`, "ok");
        void qc.invalidateQueries({ queryKey: ["work"] });
        void refreshSessionLists(qc).catch(() => undefined);
      }}
    />
  );
}

/** One line for a change on the task: what was recorded with it, else the status it moved to. */
function eventText(e: WorkEvent): string {
  if (e.reason) return e.reason;
  if (e.toStatus) return STATUS_LABELS[e.toStatus as WorkStatus] ?? e.toStatus;
  return e.kind.charAt(0).toUpperCase() + e.kind.slice(1);
}

/**
 * A task with no chat yet: what it is, and a composer. The first message creates the chat (filed under the task,
 * on the agent that answers for its area), makes it primary and is sent into it.
 */
function FirstMessage({
  d,
  scroll,
  lead,
  prefill,
}: {
  d: WorkDetail;
  scroll: "window" | "element";
  lead: React.ReactNode;
  prefill?: TaskDraft;
}) {
  const { item } = d;
  const qc = useQueryClient();
  const { toast } = useToast();
  const online = useOnline();
  const agent = useNodeAgent(item.id, item.updatedAt);
  const answerer = answererName({ agentProfile: agent?.routed ? agent.profile : null, assistant: "the assistant" });
  // Files need a conversation to be uploaded to: they are offered once the first message has made one.
  const attachments = useChatAttachments("");
  const [text, setText] = useState(prefill?.text ?? "");
  const [seenPrefill, setSeenPrefill] = useState(prefill?.at);
  if (prefill && prefill.at !== seenPrefill) {
    setSeenPrefill(prefill.at);
    setText(prefill.text);
  }
  const later = () => toast("Send a first message, then attach to this chat.", "neutral");
  const send = async (input: string, key: string) => {
    try {
      // A handoff put in this composer is recorded on the task with the chat it starts.
      const chat = await api.post<{ sessionId: string; created: boolean }>(
        `/api/work/items/${encodeURIComponent(item.id)}/chat`,
        prefill?.handoff ? { handoff: true } : {},
      );
      // The thread takes this send over as soon as it mounts: it shows the message at once and streams the reply.
      const run = api.post<RunView>(`/api/hermes/sessions/${encodeURIComponent(chat.sessionId)}/runs`, {
        input,
        idempotencyKey: key,
        capabilities: [SMART_CAPABILITY],
      });
      setFirstRun(chat.sessionId, { input, key, run });
      qc.setQueryData<WorkDetail>(["work", "item", item.id], (old) => (old ? { ...old, item: { ...old.item, primarySessionId: chat.sessionId } } : old));
      void qc.invalidateQueries({ queryKey: ["work"] });
      void refreshSessionLists(qc).catch(() => undefined);
      return true;
    } catch (err) {
      toast(`Not sent: ${(err as Error).message}`, "danger");
      return false;
    }
  };
  const docked = scroll === "element";
  const happened = [...d.events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
  // On a page that scrolls, the pane fills what is left of the screen, so the composer rests at the bottom.
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || scroll !== "window") return;
    const place = () => el.style.setProperty("--chat-top", `${Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY))}px`);
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(document.body);
    return () => observer?.disconnect();
  }, [scroll]);
  return (
    <div ref={root} className="tc-first chat-page" data-scroll={scroll} data-testid="task-no-chat">
      <div className="tc-first-body">
        {lead}
        {/* Beside Overview (docked) the summary and the log are already on screen: a thing is drawn once. */}
        {docked ? (
          <p className="tc-first-what tc-first-quiet">No chat on this task yet.</p>
        ) : (
          <p className="tc-first-what">{item.summary || item.nextAction || "No chat on this task yet."}</p>
        )}
        {happened.length && !docked ? (
          <ol className="tc-first-log" aria-label="What has happened">
            {happened.map((e) => (
              <li key={e.id}>
                <time dateTime={e.at} data-dynamic>
                  {relativeTime(e.at)}
                </time>
                <span>{eventText(e)}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
      <Composer
        surface={scroll === "element" ? "panel" : "page"}
        sessionId={null}
        text={text}
        onText={setText}
        answerer={answerer}
        placeholder="What should happen?"
        // Who gets the first message: the agent that answers for this task's area.
        lead={agent?.requested ? <NodeAgentChip nodeId={item.id} version={item.updatedAt} /> : undefined}
        online={online}
        context={[]}
        onRemoveContext={() => undefined}
        onAttach={later}
        attachments={{ ...attachments, add: later }}
        onSend={send}
        repo={d.area?.settings.defaultRepo ?? null}
        commands={NO_COMMANDS}
        keyPrefix="task"
        testIds={{ input: "task-first-input", send: "task-first-send" }}
      />
    </div>
  );
}
