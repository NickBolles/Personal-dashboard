"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChipButton, Menu, type KMenuItem } from "@/components/ui/kit";
import { cx, useToast } from "@/components/ui";
import { api } from "@/lib/client/api";
import { refreshSessionLists } from "@/lib/client/session-lists";
import type { ChatAction } from "@/lib/chat/actions";

/** Bridge to Conversation's existing tray callback, scoped so the global rail cannot open another chat. */
export const OPEN_CHAT_RUNNING = "jarvis:chat-running";

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
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [expanded, setExpanded] = useState(false);
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
    mutationFn: (a: ChatAction) => api.post<{ id: string }>("/api/hermes/sessions", { title: `Focus: ${a.title ?? a.label}`, areaId: a.itemId }),
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
        ...(action.itemId ? [{ label: "Focus", disabled: focus.isPending, onSelect: () => focus.mutate(action) }] : []),
      ]
    : [];
  return (
    <div
      ref={root}
      data-testid="actions-taken"
      role="group"
      aria-label={areaHint ? `Actions in ${areaHint}` : "Actions taken"}
      className={cx("mt-1 flex min-w-0 flex-wrap items-center gap-1", compact ? "text-xs" : "text-sm")}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setSelected(null);
      }}
    >
      <span className="mr-1 text-xs font-medium text-muted">Actions</span>
      {(expanded ? actions : actions.slice(0, 8)).map((a) => {
        const full = a.title ? `${a.label} · ${a.title}` : a.label;
        const title = a.title && a.title.length > 40 ? `${a.title.slice(0, 39)}…` : a.title;
        return (
          <ChipButton
            key={a.id}
            className="min-h-6 max-w-full border-dashed border-[var(--ai)] text-[var(--ai)]"
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
              {a.label}
              {title ? ` · ${title}` : ""}
            </span>
          </ChipButton>
        );
      })}
      {!expanded && actions.length > 8 ? (
        <ChipButton aria-expanded={false} onClick={() => setExpanded(true)} className="min-h-6">
          +{actions.length - 8} more
        </ChipButton>
      ) : null}
      {action ? (
        <div id={menuId} className="basis-full">
          <Menu label={`Actions for ${action.title ?? action.label}`} items={items} onClose={close} className="w-52 min-w-0 max-w-full" />
        </div>
      ) : null}
    </div>
  );
}
