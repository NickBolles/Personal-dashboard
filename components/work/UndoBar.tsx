"use client";

import { useEffect } from "react";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui";
import { useWorkMutation } from "./common";

export type UndoOp = { id: string; kind: string; label: string };
export const UNDO_VISIBLE_MS = 10_000;

/**
 * "Moved · Undo" bar shown for ~10 s after a structural change. The server
 * decides whether undo is still safe (only the item's latest operation).
 * Mount with key={op.id} so each operation gets a fresh timer.
 */
export function UndoBar({ op, onDone, onUndone }: { op: UndoOp; onDone: () => void; onUndone?: (r: { itemId: string; item: unknown | null }) => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, UNDO_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [onDone]);
  const undo = useWorkMutation(() => api.post<{ itemId: string; item: unknown | null; outcome: string }>(`/api/work/ops/${encodeURIComponent(op.id)}/undo`), {
    ok: "Undone",
    onSuccess: (r) => {
      onUndone?.(r);
      onDone();
    },
  });
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(144px+env(safe-area-inset-bottom))] z-[61] flex justify-center px-4 lg:bottom-40">
      <div role="status" className="pointer-events-auto flex max-w-md items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2 text-sm shadow-lg">
        <span>{op.label}</span>
        <Button size="sm" variant="primary" busy={undo.isPending} onClick={() => undo.mutate(undefined)}>
          Undo
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} aria-label="Dismiss">
          ✕
        </Button>
      </div>
    </div>
  );
}
