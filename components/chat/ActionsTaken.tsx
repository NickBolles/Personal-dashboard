"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, ChipButton, Menu, cx, useToast, type KMenuItem } from "@/components/ui";
import { CheckIcon, ChevronIcon } from "@/components/icons";
import { api } from "@/lib/client/api";
import { refreshSessionLists } from "@/lib/client/session-lists";
import { actionRows, focusTarget, summarizeActions, type ActionRow, type ChatAction } from "@/lib/chat/actions";

/** Bridge to Conversation's existing tray callback, scoped so the global rail cannot open another chat. */
export const OPEN_CHAT_RUNNING = "jarvis:chat-running";

/** Things the agent only proposed (nothing applied yet) keep the dashed "proposed" outline; everything else is done. */
const PROPOSED = new Set<ChatAction["kind"]>(["device_proposal", "quick_action"]);

/**
 * What a reply did, in plain words. One action shows as itself; several show as one summary line
 * ("Created 1 item, started 2 runs") that opens the list. Repeats are folded ("Started 2 runs").
 * Each row keeps its menu (Open / Undo / Focus); handed-off work opens the chat's Running tab.
 */
export function ActionsTaken({
  actions,
  sessionId,
  areaHint,
  compact = false,
}: {
  actions: ChatAction[];
  sessionId?: string;
  areaHint?: string | null;
  compact?: boolean;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const { toast } = useToast();
  const menuId = useId();
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => actionRows(actions), [actions]);
  const [selected, setSelected] = useState<string | null>(null);
  const [undone, setUndone] = useState<Set<string>>(() => new Set());
  const action = actions.find((a) => a.id === selected);
  const close = () => {
    setSelected(null);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!selected) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setSelected(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [selected]);
  const undo = useMutation({
    mutationFn: (opId: string) => api.post(`/api/work/ops/${encodeURIComponent(opId)}/undo`),
    onSuccess: (_, opId) => {
      setUndone((old) => new Set(old).add(opId));
      toast("Undone", "ok");
      void qc.invalidateQueries({ queryKey: ["work"] });
      void qc.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (err) => toast(`Not undone: ${(err as Error).message}`, "danger"),
  });
  const focus = useMutation({
    mutationFn: (a: ChatAction) => api.post<{ id: string }>("/api/hermes/sessions", { title: `Focus: ${a.title ?? a.label}`, areaId: focusTarget(a) }),
    onSuccess: (session) => {
      void refreshSessionLists(qc).catch(() => undefined);
      router.push(`/chat/${encodeURIComponent(session.id)}`);
    },
    onError: (err) => toast(`Couldn't focus: ${(err as Error).message}`, "danger"),
  });
  if (!actions.length) return null;
  const openRunning = () => {
    if (!sessionId) return;
    if (window.location.pathname === `/chat/${encodeURIComponent(sessionId)}`) {
      window.dispatchEvent(new CustomEvent(OPEN_CHAT_RUNNING, { detail: { sessionId } }));
    } else {
      router.push(`/chat/${encodeURIComponent(sessionId)}?panel=running`);
    }
  };
  const href = action?.href;
  const navigable = !!href && (/^\/(?![\\/])/.test(href) || /^https:\/\//.test(href));
  const items: KMenuItem[] = action
    ? [
        {
          label: "Open",
          disabled: !navigable,
          onSelect: () => {
            if (!href || !navigable) return;
            if (href.startsWith("https://")) window.open(href, "_blank", "noopener,noreferrer");
            else router.push(href);
          },
        },
        ...(action.undoOpId ? [{ label: "Undo", disabled: undo.isPending || undone.has(action.undoOpId), onSelect: () => undo.mutate(action.undoOpId!) }] : []),
        ...(focusTarget(action) ? [{ label: "Focus", disabled: focus.isPending, onSelect: () => focus.mutate(action) }] : []),
      ]
    : [];
  const chip = ({ action: a, label, full }: ActionRow) => {
    const title = a.title && a.title.length > 40 ? `${a.title.slice(0, 39)}…` : a.title;
    return (
      <ChipButton
        className={cx("min-h-8 max-w-full border-[var(--aib)] text-[var(--ai)] sm:min-h-6", PROPOSED.has(a.kind) && "border-dashed")}
        title={full}
        aria-label={full}
        aria-haspopup={a.kind === "delegated" ? undefined : "menu"}
        aria-expanded={a.kind === "delegated" ? undefined : selected === a.id}
        aria-controls={selected === a.id ? menuId : undefined}
        disabled={a.kind === "delegated" && !sessionId}
        onClick={(event) => {
          trigger.current = event.currentTarget;
          if (a.kind === "delegated") openRunning();
          else setSelected((old) => (old === a.id ? null : a.id));
        }}
      >
        <span className="truncate">
          {label}
          {title ? ` · ${title}` : ""}
        </span>
      </ChipButton>
    );
  };
  const menu = action ? (
    <div id={menuId} className="mt-1">
      <Menu label={`Actions for ${action.title ?? action.label}`} items={items} onClose={close} className="w-52 min-w-0 max-w-full" />
    </div>
  ) : null;
  return (
    <div
      ref={root}
      data-testid="actions-taken"
      role="group"
      aria-label={areaHint ? `Actions in ${areaHint}` : "Actions taken"}
      className={cx("chat-actions mt-1 min-w-0", compact ? "text-xs" : "text-sm")}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setSelected(null);
      }}
    >
      {rows.length === 1 ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <CheckIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ai)]" />
          {chip(rows[0])}
        </div>
      ) : (
        <>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            onClick={() => {
              setExpanded((open) => !open);
              setSelected(null);
            }}
            className={cx(
              "chat-actions-head -ml-2 h-auto max-w-full justify-start gap-1.5 px-2 py-1 text-left whitespace-normal",
              compact ? "text-xs" : "text-sm",
            )}
          >
            <CheckIcon className="h-3.5 w-3.5 shrink-0 text-[var(--ai)]" />
            <span className="min-w-0 break-words">{summarizeActions(actions)}</span>
            <ChevronIcon className={cx("h-3.5 w-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
          </Button>
          {expanded ? (
            <ul id={listId} className="mt-1 flex min-w-0 flex-wrap gap-1" aria-label="What was done">
              {rows.map((row) => (
                <li key={row.action.id} className="max-w-full min-w-0">
                  {chip(row)}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      {menu}
    </div>
  );
}
