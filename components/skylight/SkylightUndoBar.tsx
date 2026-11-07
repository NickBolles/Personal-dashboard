"use client";

import { useEffect, type CSSProperties } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, useOnline, useToast } from "@/components/ui";
import { haptic, skylightWrites } from "./writeStore";

const UNDO_VISIBLE_MS = 10_000;

export function SkylightUndoBar({
  op,
  rowKey,
  onDone,
  onUndone,
}: {
  op: { id: string; label: string };
  /** Row the write landed on: Undo plays its reverse animation (restored → re-enters its list). */
  rowKey?: string;
  onDone: () => void;
  onUndone: () => void;
}) {
  const online = useOnline();
  const { toast } = useToast();
  const undo = useMutation({
    mutationFn: () => {
      if (rowKey) skylightWrites.undo(rowKey);
      return api.post<{ ok: boolean; message: string }>(`/api/skylight/write/${encodeURIComponent(op.id)}/undo`);
    },
    onSuccess: () => {
      if (rowKey) skylightWrites.undone(rowKey);
      haptic(8);
      toast("Undone", "ok");
      onUndone();
      onDone();
    },
    onError: (error: Error) => {
      if (rowKey) skylightWrites.undoError(rowKey);
      toast(error.message, "danger");
    },
  });
  useEffect(() => {
    const timer = setTimeout(onDone, UNDO_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [onDone]);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(144px+env(safe-area-inset-bottom))] z-[61] flex justify-center px-4 lg:bottom-40">
      <div
        role="status"
        className="jv-undo sk-undo-in pointer-events-auto relative flex max-w-md flex-wrap items-center gap-3 overflow-hidden rounded-xl border border-line bg-surface px-4 py-2 text-sm shadow-lg"
        style={{ "--undo-ms": `${UNDO_VISIBLE_MS}ms` } as CSSProperties}
      >
        <span>{op.label}</span>
        <Button type="button" size="sm" variant="primary" disabled={!online} busy={undo.isPending} onClick={() => undo.mutate()}>
          Undo
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone} aria-label="Dismiss">
          ✕
        </Button>
        <span aria-hidden="true" className="jv-undo-bar" />
      </div>
    </div>
  );
}
