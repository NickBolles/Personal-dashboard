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
  const [undo, setUndo] = useState<{ id: string; label: string; key?: string } | null>(null);
  // Row key (action id) of the write being confirmed: its row shimmers while pending, shakes on rollback.
  const keyRef = useRef<string | undefined>(undefined);
  // Shown inside the confirm sheet (a toast lands under/over the sheet and loses Skylight's reason).
  const [failure, setFailure] = useState<{ message: string; reason?: string; status?: number } | null>(null);
  const qc = useQueryClient();
  const online = useOnline();
  const { toast } = useToast();
  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["source", "skylight"] });
    void qc.invalidateQueries({ queryKey: ["home"] });
    void qc.invalidateQueries({ queryKey: ["source", "todos"] });
  }, [qc]);
  const dismissUndo = useCallback(() => setUndo(null), []);
  const mutation = useMutation({
    mutationFn: (value: SkylightWriteOp) => api.post<SkylightWriteResult>("/api/skylight/write", value),
    onSuccess: (result, value) => {
      const key = keyRef.current;
      if (key) skylightWrites.success(key, result.writeId);
      haptic(8);
      setOp(null);
      setFailure(null);
      invalidate();
      if (result.undoable) setUndo({ id: result.writeId, label: doneLabel(value), key });
      else {
        setUndo(null);
        toast(doneLabel(value), "ok");
      }
    },
    onError: (error: Error) => {
      if (keyRef.current) skylightWrites.error(keyRef.current);
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
  });
  const request = useCallback<SkylightRequest>((value, key) => {
    keyRef.current = key;
    setFailure(null);
    setOp(value);
  }, []);
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
                busy={mutation.isPending}
                disabled={!online}
                title={!online ? "Unavailable offline" : undefined}
                onClick={() => {
                  if (!op || !online || mutation.isPending) return;
                  // Optimistic: the row draws its tick and shimmers until Skylight confirms (a double tap is ignored).
                  if (keyRef.current) skylightWrites.confirm(keyRef.current, op);
                  mutation.mutate(op);
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
        {undo ? <SkylightUndoBar key={undo.id} op={undo} rowKey={undo.key} onDone={dismissUndo} onUndone={invalidate} /> : null}
      </>
    ),
  };
}
