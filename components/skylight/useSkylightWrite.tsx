"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { describeSkylightWrite, doneLabel, type SkylightWriteOp, type SkylightWriteResult } from "@/lib/skylight-write";
import { Button, Dialog, useOnline, useToast } from "@/components/ui";
import { SkylightUndoBar } from "./SkylightUndoBar";
import { haptic, skylightWrites } from "./writeStore";

export type SkylightRequest = (op: SkylightWriteOp, key?: string) => void;

/** Lets rows deep inside a surface (Home feed, tray card) request a confirmed write without prop drilling. */
export const SkylightWriteContext = createContext<{ request: SkylightRequest; writable: boolean } | null>(null);
export const useSkylightWriteContext = () => useContext(SkylightWriteContext);

export function useSkylightWrite() {
  const [op, setOp] = useState<SkylightWriteOp | null>(null);
  const [undos, setUndos] = useState<{ id: string; label: string; key?: string }[]>([]);
  const undo = undos.at(-1);
  // Row key (action id) of the write being confirmed: its row shimmers while pending, shakes on rollback.
  const keyRef = useRef<string | undefined>(undefined);
  const inFlight = useRef(new Set<string>());
  const targetKey = (value: SkylightWriteOp, key?: string) =>
    key ??
    ("choreId" in value
      ? `chore:${value.choreId}`
      : "itemId" in value
        ? `item:${value.itemId}`
        : "eventId" in value
          ? `event:${value.eventId}`
          : JSON.stringify(value));
  // Shown inside the confirm sheet (a toast lands under/over the sheet and loses Skylight's reason).
  const [failure, setFailure] = useState<{ message: string; reason?: string; status?: number } | null>(null);
  const qc = useQueryClient();
  const online = useOnline();
  const { toast } = useToast();
  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["source", "skylight"] });
    void qc.invalidateQueries({ queryKey: ["home"] });
    void qc.invalidateQueries({ queryKey: ["source", "todos"] });
    void qc.invalidateQueries({ queryKey: ["away"] });
    void qc.invalidateQueries({ queryKey: ["smart-dynamic"] });
  }, [qc]);
  const undoId = undo?.id;
  const dismissUndo = useCallback(() => setUndos((rows) => rows.filter((row) => row.id !== undoId)), [undoId]);
  const mutation = useMutation({
    mutationFn: ({ value }: { value: SkylightWriteOp; key?: string }) => api.post<SkylightWriteResult>("/api/skylight/write", value),
    onSuccess: (result, { value, key }) => {
      if (key) skylightWrites.success(key, result.writeId);
      haptic(8);
      setOp((current) => (current === value ? null : current));
      invalidate();
      if (result.undoable) setUndos((rows) => [...rows, { id: result.writeId, label: doneLabel(value), key }]);
      else {
        toast(doneLabel(value), "ok");
      }
    },
    onError: (error: Error, { key }) => {
      if (key) skylightWrites.error(key);
      haptic([12, 40, 12]);
      // ApiError.detail carries Skylight's own reason ({ status, reason }) when the server had one.
      const raw = (error as { detail?: unknown }).detail;
      const d = raw && typeof raw === "object" ? (raw as { reason?: unknown; status?: unknown }) : {};
      setFailure({
        message: error.message,
        ...(typeof d.reason === "string" ? { reason: d.reason } : {}),
        ...(typeof d.status === "number" ? { status: d.status } : {}),
      });
    },
    onSettled: (_result, _error, { value, key }) => {
      inFlight.current.delete(targetKey(value, key));
    },
  });
  const execute = (value: SkylightWriteOp, key?: string) => {
    if (!online || inFlight.current.has(targetKey(value, key))) return;
    if (key && !skylightWrites.confirm(key, value)) return;
    inFlight.current.add(targetKey(value, key));
    mutation.mutate({ value, key });
  };
  const request: SkylightRequest = (value, key) => {
    if (!online || inFlight.current.has(targetKey(value, key))) return;
    keyRef.current = key;
    setFailure(null);
    // Owner override: the deliberate completion/Skip click IS confirmation. Other writes still review.
    if (value.op === "chore.complete" || value.op === "chore.skip") {
      setOp(null);
      execute(value, key);
      return;
    }
    setOp(value);
  };
  return {
    request,
    node: (
      <>
        <Dialog
          open={op !== null}
          title="Confirm Skylight change"
          onClose={() => {
            if (!mutation.isPending) {
              setOp(null);
              setFailure(null);
            }
          }}
          footer={
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={mutation.isPending}
                onClick={() => {
                  setOp(null);
                  setFailure(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                loading={mutation.isPending}
                disabled={!online}
                title={!online ? "Unavailable offline" : undefined}
                onClick={() => {
                  if (!op || !online || mutation.isPending) return;
                  // Optimistic: the row draws its tick and shimmers until Skylight confirms (a double tap is ignored).
                  execute(op, keyRef.current);
                }}
              >
                Confirm
              </Button>
            </>
          }
        >
          <p className="text-sm">{op ? describeSkylightWrite(op) : ""}</p>
          {failure ? (
            <div role="alert" className="mt-3 rounded-lg border border-danger bg-danger-soft px-3 py-2 text-sm text-danger" data-testid="skylight-write-error">
              <p>{failure.message}</p>
              {failure.reason || failure.status ? (
                <details className="mt-1 text-xs text-muted">
                  <summary className="cursor-pointer">Details</summary>
                  <p className="mt-1 break-words" data-dynamic>
                    {failure.status ? `Skylight ${failure.status}` : "Skylight"}
                    {failure.reason ? `: ${failure.reason}` : ""}
                  </p>
                </details>
              ) : null}
            </div>
          ) : null}
        </Dialog>
        {!op && failure ? (
          <div role="alert" className="my-2 text-sm text-danger" data-testid="skylight-write-error">
            {failure.message}
            {failure.reason ? `: ${failure.reason}` : ""}
          </div>
        ) : null}
        {undo ? <SkylightUndoBar key={undo.id} op={undo} rowKey={undo.key} onDone={dismissUndo} onUndone={invalidate} /> : null}
      </>
    ),
  };
}
