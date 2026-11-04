"use client";

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { describeSkylightWrite, doneLabel, type SkylightWriteOp, type SkylightWriteResult } from "@/lib/skylight-write";
import { Button, Dialog, useOnline, useToast } from "@/components/ui";
import { SkylightUndoBar } from "./SkylightUndoBar";

export function useSkylightWrite() {
  const [op, setOp] = useState<SkylightWriteOp | null>(null);
  const [undo, setUndo] = useState<{ id: string; label: string } | null>(null);
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
      setOp(null);
      invalidate();
      if (result.undoable) setUndo({ id: result.writeId, label: doneLabel(value) });
      else {
        setUndo(null);
        toast(doneLabel(value), "ok");
      }
    },
    onError: (error: Error) => toast(error.message, "danger"),
  });
  const request = useCallback((value: SkylightWriteOp) => setOp(value), []);
  return {
    request,
    node: (
      <>
        <Dialog
          open={op !== null}
          title="Confirm Skylight change"
          onClose={() => {
            if (!mutation.isPending) setOp(null);
          }}
          footer={
            <>
              <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={() => setOp(null)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                busy={mutation.isPending}
                disabled={!online}
                title={!online ? "Unavailable offline" : undefined}
                onClick={() => {
                  if (op && online && !mutation.isPending) mutation.mutate(op);
                }}
              >
                Confirm
              </Button>
            </>
          }
        >
          <p className="text-sm">{op ? describeSkylightWrite(op) : ""}</p>
        </Dialog>
        {undo ? <SkylightUndoBar key={undo.id} op={undo} onDone={dismissUndo} onUndone={invalidate} /> : null}
      </>
    ),
  };
}
