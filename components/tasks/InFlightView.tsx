"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "@/components/icons";
import {
  Button,
  ButtonLink,
  EmptyState,
  IconButton,
  Input,
  KSpinner,
  Segmented,
  SelectPicker,
  SideDock,
  SplitPane,
  useSplitWidth,
  useToast,
} from "@/components/ui";
import { useMarkLooked } from "@/components/coordinator/running/useCoordinatorRuns";
import { TaskChat } from "@/components/work/TaskChat";
import { UndoBar, type UndoOp } from "@/components/work/UndoBar";
import { api } from "@/lib/client/api";
import { setFirstRun } from "@/lib/client/first-run";
import { refreshSessionLists } from "@/lib/client/session-lists";
import type { RunView } from "@/lib/hermes";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import type { ItemsResponse, WorkDetail, WorkItem } from "@/lib/work";
import { TaskList, taskHref, useCanChat } from "./TaskList";
import "@/components/work/task-chat.css";

const VIEWS = [
  { value: "flight", label: "In flight" },
  { value: "all", label: "All" },
] as const;
type View = (typeof VIEWS)[number]["value"];

const LAST_CHANNEL = "jarvis.tasks.channel";

/**
 * "Add a task": the task is created in the chosen channel, and what was typed opens its chat (the channel's bot
 * gets it as the first message). Without chat access it is created and opened, nothing is sent.
 */
export function AddTask({ channelId, onAdded }: { channelId?: string; onAdded?: (item: WorkItem) => void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const { toast } = useToast();
  const canChat = useCanChat();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string>("");
  const items = useQuery({ queryKey: ["work", "items"], queryFn: () => api.get<ItemsResponse>("/api/work/items"), enabled: !channelId, staleTime: 30_000 });
  const channels = (items.data?.items ?? []).filter((i) => i.parentId === null && !i.archived);
  useEffect(() => {
    try {
      const last = window.localStorage.getItem(LAST_CHANNEL);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the remembered channel is only known in the browser, after the first paint
      if (last) setPicked(last);
    } catch {
      /* a private window: start from the first channel */
    }
  }, []);
  const target = channelId ?? (channels.some((c) => c.id === picked) ? picked : (channels[0]?.id ?? ""));
  const add = useMutation({
    mutationFn: async (input: string) => {
      const title = input.split("\n")[0]!.trim().slice(0, 160);
      const { item } = await api.post<{ item: WorkItem }>("/api/work/items", { kind: "thread", parentId: target, title });
      if (!canChat) return { item, sent: false };
      try {
        const chat = await api.post<{ sessionId: string }>(`/api/work/items/${encodeURIComponent(item.id)}/chat`, {});
        const key = crypto.randomUUID();
        const run = api.post<RunView>(`/api/hermes/sessions/${encodeURIComponent(chat.sessionId)}/runs`, {
          input,
          idempotencyKey: key,
          capabilities: [SMART_CAPABILITY],
        });
        setFirstRun(chat.sessionId, { input, key, run });
        void refreshSessionLists(qc).catch(() => undefined);
        return { item, sent: true };
      } catch {
        // The task exists; its chat did not start. Say so and open it: the same words can be sent from there.
        return { item, sent: false, failed: true };
      }
    },
    onSuccess: ({ item, sent, failed }) => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["work"] });
      if (failed) toast("Task added. Its chat did not start: send from the task.", "danger");
      else toast(sent ? "Task added and sent" : "Task added");
      onAdded?.(item);
      router.push(taskHref(item.id, "chat"));
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't add the task. Try again.", "danger"),
  });
  const ready = !!text.trim() && !!target && !add.isPending;
  return (
    <form
      className="tl-add"
      data-testid="add-task"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) add.mutate(text.trim());
      }}
    >
      <Input
        aria-label="Add a task"
        placeholder="Add a task…"
        value={text}
        maxLength={2000}
        icon={<PlusIcon className="h-4 w-4" />}
        onChange={(e) => setText(e.target.value)}
        className="tl-add-input"
      />
      {channelId ? null : (
        <SelectPicker
          label="Channel"
          value={target}
          options={channels.map((c) => ({ value: c.id, label: c.title }))}
          onChange={(value) => {
            setPicked(value);
            try {
              window.localStorage.setItem(LAST_CHANNEL, value);
            } catch {
              /* not remembered, still used */
            }
          }}
          testId="add-task-channel"
        />
      )}
      <Button type="submit" size="sm" disabled={!ready} loading={add.isPending}>
        Add
      </Button>
    </form>
  );
}

/** The picked task's chat, docked beside the list (600px and wider). The task page is one tap away. */
function TaskThread({ id, onClose }: { id: string; onClose: () => void }) {
  const [undo, setUndo] = useState<UndoOp | null>(null);
  const q = useQuery({
    queryKey: ["work", "item", id],
    queryFn: ({ signal }) => api.get<WorkDetail>(`/api/work/items/${encodeURIComponent(id)}`, signal),
    refetchInterval: 30_000,
  });
  return (
    <SideDock
      label="Task chat"
      testId="inflight-thread"
      header={
        <div className="tl-thread-head">
          <Link href={taskHref(id)} className="tl-thread-title">
            {q.data?.item.title ?? "Task"}
          </Link>
          <ButtonLink href={taskHref(id)} size="sm" variant="ghost">
            Overview
          </ButtonLink>
          <IconButton
            label="Close chat"
            onClick={onClose}
            icon={
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            }
          />
        </div>
      }
    >
      {q.data ? (
        <TaskChat d={q.data} scroll="element" onOp={(op) => setUndo(op ?? null)} />
      ) : q.error ? (
        <p className="tl-quiet">Couldn&apos;t load this task</p>
      ) : (
        <KSpinner label="Loading…" />
      )}
      {undo ? <UndoBar key={undo.id} op={undo} onDone={() => setUndo(null)} /> : null}
    </SideDock>
  );
}

/**
 * In flight: your tasks, one row each. "In flight" holds what needs you, is working, stalled or failed; "All" holds
 * every open task by channel, then project. With room, picking a row shows its chat beside the list.
 */
export function InFlightView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const root = useRef<HTMLDivElement>(null);
  const wide = useSplitWidth(root, 600);
  const view: View = params.get("view") === "all" ? "all" : "flight";
  const picked = params.get("task");
  const { mutate: markLooked } = useMarkLooked();
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current) return;
    marked.current = true;
    // "Done since you looked" counts from the visit before this one.
    const t = window.setTimeout(() => markLooked("running"), 4_000);
    return () => window.clearTimeout(t);
  }, [markLooked]);
  const set = (change: Record<string, string | null>) => {
    const search = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(change)) {
      if (value === null) search.delete(key);
      else search.set(key, value);
    }
    router.replace(`${pathname}${search.size ? `?${search}` : ""}`, { scroll: false });
  };
  const list = (
    <div className="tl-page">
      <header className="tl-head">
        <h1 className="tl-h1">In flight</h1>
        <Segmented label="Which tasks" options={[...VIEWS]} value={view} onChange={(next) => set({ view: next === "flight" ? null : next })} />
      </header>
      <TaskList
        scope="all"
        view={view}
        onPick={wide ? (row) => set({ task: row.id }) : undefined}
        selectedId={wide ? picked : null}
        empty={<EmptyState title={view === "flight" ? "Nothing in flight" : "No open tasks"} />}
      />
      <AddTask />
    </div>
  );
  const split = wide && !!picked;
  return (
    <div ref={root} className="tl-shell" data-testid="in-flight" data-split={split || undefined}>
      <SplitPane
        split={split}
        value="list"
        onChange={() => undefined}
        panes={[
          { id: "list", label: "Tasks", content: list },
          { id: "thread", label: "Chat", content: picked ? <TaskThread key={picked} id={picked} onClose={() => set({ task: null })} /> : null },
        ]}
      />
    </div>
  );
}
