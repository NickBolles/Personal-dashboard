"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { Decision } from "@/lib/cw-decisions";
import type { UndoOp } from "@/components/work/UndoBar";
import { useToast } from "@/components/ui";

export const DECISIONS_KEY = ["work", "coordinator", "decisions"] as const;
export const DECISION_UNDO_MS = 10_000;
export type DecisionsResponse = { decisions: Decision[]; counts: { open: number; deferred: number } };
export type AnswerResult = { decision: Decision; repeated?: boolean; op: UndoOp | null };
export type NeedsOpenOptions = { arm?: string; ask?: boolean };

export function useCoordinatorDecisions() {
  return useQuery({
    queryKey: DECISIONS_KEY,
    queryFn: ({ signal }) => api.get<DecisionsResponse>("/api/coordinator/decisions?state=open", signal),
    refetchInterval: 30_000,
  });
}
function useInvalidateDecisions() {
  const client = useQueryClient();
  return () => Promise.all([client.invalidateQueries({ queryKey: ["work"] }), client.invalidateQueries({ queryKey: ["activity"] })]);
}
export function useAnswerDecision() {
  const invalidate = useInvalidateDecisions();
  return useMutation({
    mutationFn: ({ ref, answer }: { ref: string; answer: string }) =>
      api.post<AnswerResult>(`/api/coordinator/decisions/${encodeURIComponent(ref)}/answer`, { answer, via: "queue", idempotencyKey: crypto.randomUUID() }),
    onSuccess: invalidate,
  });
}
export function useDeferDecision() {
  const invalidate = useInvalidateDecisions();
  return useMutation({
    mutationFn: ({ ref, until }: { ref: string; until: string }) =>
      api.post<{ decision: Decision }>(`/api/coordinator/decisions/${encodeURIComponent(ref)}/defer`, { until }),
    onSuccess: invalidate,
  });
}

export type DecisionNotice = { id: string; text: string; undo: () => Promise<void> };
/** Panel-owned so a toast survives list/detail navigation and the 600 ms auto-advance. */
export const DecisionFeedbackContext = createContext<ReturnType<typeof useDecisionFeedbackController> | null>(null);
export function useDecisionFeedbackController() {
  const [notices, setNotices] = useState<DecisionNotice[]>([]);
  const [deferring, setDeferring] = useState<string[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const undoing = useRef(new Set<string>());
  const undoneOps = useRef(new Set<string>());
  const stagedRefs = useRef(new Set<string>());
  /** Writes staged behind a grace period: committed (not dropped) if the panel unmounts first. */
  const pendingExpiry = useRef(new Map<string, () => void>());
  const invalidate = useInvalidateDecisions();
  const defer = useDeferDecision();
  const { toast } = useToast();
  useEffect(() => {
    const active = timers.current;
    const pending = pendingExpiry.current;
    return () => {
      active.forEach(clearTimeout);
      active.clear();
      // Leaving the tab is not Undo: a staged defer still happens.
      pending.forEach((commit) => commit());
      pending.clear();
    };
  }, []);

  function remove(id: string) {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setNotices((rows) => rows.filter((n) => n.id !== id));
  }
  function showUndo(text: string, action: () => Promise<void>, onExpire?: () => void) {
    const id = crypto.randomUUID();
    const undo = async () => {
      if (undoing.current.has(id)) return;
      undoing.current.add(id);
      clearTimeout(timers.current.get(id));
      pendingExpiry.current.delete(id);
      try {
        await action();
        remove(id);
        toast("Undone");
      } catch (error) {
        toast(error instanceof Error ? error.message : "Couldn't undo. Try again.", "danger");
      } finally {
        undoing.current.delete(id);
      }
    };
    setNotices((rows) => [...rows, { id, text, undo }]);
    if (onExpire) pendingExpiry.current.set(id, onExpire);
    timers.current.set(
      id,
      setTimeout(() => {
        remove(id);
        pendingExpiry.current.delete(id);
        onExpire?.();
      }, DECISION_UNDO_MS),
    );
    return undo;
  }
  async function undoOps(ops: readonly UndoOp[]) {
    // Retain only not-yet-undone operations if a later undo in a batch fails.
    try {
      for (const op of [...ops].reverse()) {
        if (undoneOps.current.has(op.id)) continue;
        await api.post(`/api/work/ops/${encodeURIComponent(op.id)}/undo`);
        undoneOps.current.add(op.id);
      }
    } finally {
      await invalidate();
    }
  }
  function stageDefer(ref: string, until: string) {
    if (stagedRefs.current.has(ref)) return;
    stagedRefs.current.add(ref);
    setDeferring((refs) => [...refs, ref]);
    const finish = () => {
      stagedRefs.current.delete(ref);
      setDeferring((refs) => refs.filter((r) => r !== ref));
    };
    // The current defer endpoint has no UndoOp/undefer route. A cancellable grace
    // period provides real Undo without pretending a nonexistent API is available.
    showUndo(
      `Deferring ${ref} in 10 s`,
      async () => {
        finish();
      },
      () => {
        void defer
          .mutateAsync({ ref, until })
          .then(
            () => {
              toast(`Deferred ${ref}`);
            },
            (error: unknown) => {
              toast(error instanceof Error ? error.message : "Couldn't defer. Try again.", "danger");
            },
          )
          .finally(finish);
      },
    );
  }
  return { notices, showUndo, undoOps, stageDefer, deferring, toast };
}
export function useDecisionFeedback() {
  const shared = useContext(DecisionFeedbackContext);
  const local = useDecisionFeedbackController();
  return { feedback: shared ?? local, shared: !!shared };
}
