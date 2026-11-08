"use client";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Dialog, useToast } from "@/components/ui";
import { inputCls } from "@/components/ui/legacy";
import { QUICK_ACTION_MANAGE, type QuickAction, type QuickActionContext, type QuickActionInput } from "@/lib/quick-actions";
import { useQuickActions, useQuickActionWrite } from "./useQuickActions";
import "./quick-actions.css";

function Editor({
  action,
  context,
  busy,
  save,
  cancel,
}: {
  action?: QuickAction;
  context: QuickActionContext;
  busy: boolean;
  save: (body: QuickActionInput) => void;
  cancel: () => void;
}) {
  const [label, setLabel] = useState(action?.label ?? "");
  const [prompt, setPrompt] = useState(action?.prompt ?? "");
  const [scope, setScope] = useState(action?.scope ?? "global");
  const labelRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    labelRef.current?.focus();
  }, []);
  return (
    <div className="grid min-w-0 gap-2 rounded-lg border border-line bg-surface-2 p-2">
      <label className="grid min-w-0 gap-1 text-xs">
        Quick action label
        <input ref={labelRef} data-autofocus className={inputCls} maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="grid min-w-0 gap-1 text-xs">
        Quick action prompt
        <textarea className={inputCls} maxLength={2000} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <label className="grid min-w-0 gap-1 text-xs">
        Quick action scope
        <select className={inputCls} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="global">Everywhere</option>
          {context.areaId ? <option value={`area:${context.areaId}`}>This area</option> : null}
          {context.path ? <option value={`page:${context.path}`}>This page</option> : null}
          {scope !== "global" && scope !== `area:${context.areaId}` && scope !== `page:${context.path}` ? <option value={scope}>{scope}</option> : null}
        </select>
      </label>
      <div className="flex flex-wrap gap-1">
        <Button className="qa-hit" variant="primary" disabled={busy || !label.trim() || !prompt.trim()} onClick={() => save({ label, prompt, scope })}>
          {action ? "Save quick action" : "Create quick action"}
        </Button>
        <Button className="qa-hit" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
export function ManageQuickActions({ open, onClose, context = {} }: { open: boolean; onClose: () => void; context?: QuickActionContext }) {
  const query = useQuickActions(open);
  const { write, undo, undoId } = useQuickActionWrite();
  const [editing, setEditing] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const { toast } = useToast();
  const actions = (query.data?.actions ?? []).filter((a) => a.status === "active");
  const close = () => {
    setEditing(null);
    onClose();
  };
  const move = (id: string, target: number) => {
    const ids = actions.map((a) => a.id);
    const index = ids.indexOf(id);
    if (index < 0 || target < 0 || target >= ids.length) return;
    ids.splice(index, 1);
    ids.splice(target, 0, id);
    write.mutate({ path: "/api/quick-actions/reorder", body: { ids }, message: "Reordered" });
  };
  const download = async () => {
    try {
      const data = await api.get<unknown[]>("/api/quick-actions/export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "quick-actions.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast((err as Error).message, "danger");
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Manage quick actions"
      size="lg"
      description="Saved prompts fill the composer. Nothing is sent automatically."
      footer={
        <Button className="qa-hit" onClick={close}>
          Done
        </Button>
      }
    >
      <div className="qa-root grid min-w-0 gap-2">
        {query.error ? (
          <p role="alert" className="text-sm text-danger">
            {query.error.message}
          </p>
        ) : null}
        {query.isLoading ? <p className="text-sm text-muted">Loading…</p> : null}
        {actions.map((a, i) => (
          <div
            key={a.id}
            className="min-w-0 border-b border-line pb-2"
            data-testid="quick-action-row"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragged && !write.isPending) move(dragged, i);
              setDragged(null);
            }}
          >
            {editing === a.id ? (
              <Editor
                action={a}
                context={context}
                busy={write.isPending}
                cancel={() => setEditing(null)}
                save={(body) =>
                  write.mutate({ path: `/api/quick-actions/${a.id}`, method: "patch", body, message: "Saved" }, { onSuccess: () => setEditing(null) })
                }
              />
            ) : (
              <div className="flex min-w-0 flex-wrap items-center gap-1">
                <button
                  type="button"
                  className="qa-hit qa-icon cursor-grab"
                  draggable={!write.isPending}
                  aria-label={`Drag ${a.label}`}
                  onDragStart={() => setDragged(a.id)}
                  onDragEnd={() => setDragged(null)}
                >
                  ⠿
                </button>
                <span className="min-w-0 flex-1 basis-24 text-sm [overflow-wrap:anywhere]">{a.label}</span>
                <div className="flex max-w-full flex-wrap gap-1">
                  <Button className="qa-hit qa-icon" aria-label={`Move up ${a.label}`} disabled={i === 0 || write.isPending} onClick={() => move(a.id, i - 1)}>
                    ↑
                  </Button>
                  <Button
                    className="qa-hit qa-icon"
                    aria-label={`Move down ${a.label}`}
                    disabled={i === actions.length - 1 || write.isPending}
                    onClick={() => move(a.id, i + 1)}
                  >
                    ↓
                  </Button>
                  <Button className="qa-hit qa-icon" aria-label={`Edit ${a.label}`} onClick={() => setEditing(a.id)}>
                    ✎
                  </Button>
                  <Button
                    className="qa-hit qa-icon"
                    aria-label={`${a.pinned ? "Unpin" : "Pin"} ${a.label}`}
                    aria-pressed={a.pinned}
                    disabled={write.isPending}
                    onClick={() => write.mutate({ path: `/api/quick-actions/${a.id}`, method: "patch", body: { pinned: !a.pinned } })}
                  >
                    {a.pinned ? "★" : "☆"}
                  </Button>
                  <Button
                    className="qa-hit qa-icon"
                    aria-label={`Delete ${a.label}`}
                    disabled={write.isPending}
                    onClick={() => write.mutate({ path: `/api/quick-actions/${a.id}`, method: "delete", message: "Deleted" })}
                  >
                    ×
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
        {editing === "new" ? (
          <Editor
            context={context}
            busy={write.isPending}
            cancel={() => setEditing(null)}
            save={(body) => write.mutate({ path: "/api/quick-actions", body, message: "Added" }, { onSuccess: () => setEditing(null) })}
          />
        ) : (
          <Button className="qa-hit justify-self-start" variant={editing === null ? "primary" : "secondary"} onClick={() => setEditing("new")}>
            + New quick action
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button className="qa-hit" onClick={() => void download()}>
            Export JSON
          </Button>
          {undoId ? (
            <span role="status" className="text-xs">
              Saved ·{" "}
              <Button className="qa-hit" disabled={undo.isPending || write.isPending} onClick={() => undo.mutate()}>
                Undo
              </Button>
            </span>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

const noticeTarget = () => document.querySelector<HTMLElement>("dialog[open].gc-sheet [data-quick-action-notices]") ?? document.body;
const subscribeNoticeTarget = (notify: () => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
  return () => observer.disconnect();
};
function QuickActionNotice({ children }: { children: ReactNode }) {
  // Follow sheet opening/closing even while a notice is already visible.
  const target = useSyncExternalStore(subscribeNoticeTarget, noticeTarget, () => null);
  if (!target) return null;
  return createPortal(
    <div
      role="status"
      className={`qa-root z-50 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-1 rounded-lg border border-line bg-surface p-2 text-sm shadow-[var(--sh2)] ${target === document.body ? "fixed inset-x-3 bottom-24" : "relative my-3 shrink-0"}`}
    >
      {children}
    </div>,
    target,
  );
}

/** A single app-shell listener: chips and palette never create competing dialogs. */
export function QuickActionsHost() {
  const path = usePathname();
  const [context, setContext] = useState<QuickActionContext | null>(null);
  const [addedOp, setAddedOp] = useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const undo = useMutation({
    mutationFn: () => api.post("/api/quick-actions/undo", { opId: addedOp }),
    onSuccess: () => {
      setAddedOp(null);
      void qc.invalidateQueries({ queryKey: ["quick-actions"] });
    },
    onError: (err) => toast((err as Error).message, "danger"),
  });
  useEffect(() => {
    const manage = (e: Event) => setContext({ path, ...(e as CustomEvent<QuickActionContext>).detail });
    const added = (e: Event) => setAddedOp((e as CustomEvent<{ opId: string }>).detail.opId);
    window.addEventListener(QUICK_ACTION_MANAGE, manage);
    window.addEventListener("jarvis:quick-action-added", added);
    return () => {
      window.removeEventListener(QUICK_ACTION_MANAGE, manage);
      window.removeEventListener("jarvis:quick-action-added", added);
    };
  }, [path]);
  return (
    <>
      <ManageQuickActions open={context !== null} context={context ?? { path }} onClose={() => setContext(null)} />
      {addedOp ? (
        <QuickActionNotice>
          Added ·{" "}
          <Button className="qa-hit" disabled={undo.isPending} onClick={() => undo.mutate()}>
            Undo
          </Button>
          <Button className="qa-hit" aria-label="Close quick action notice" onClick={() => setAddedOp(null)}>
            ×
          </Button>
        </QuickActionNotice>
      ) : null}
    </>
  );
}
