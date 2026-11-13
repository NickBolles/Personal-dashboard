"use client";

/**
 * The one way a decision (D-n) is answered, on every surface: one API path, one optimistic update, one set of
 * queries refreshed, one receipt, one Undo.
 *
 * - `useAnswerDecision`: the write itself. It asks `answerGate` before it posts, so a risk-flagged decision is
 *   never sent without the owner's second, explicit tap, whatever the surface forgot to check.
 * - `useDecisionFlow`: what a surface holds while its decisions are on screen: which are being sent, the
 *   10-second receipts with their Undo, and the staged (cancellable) defers.
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { useToast } from "@/components/ui";
import type { UndoOp } from "@/components/work/UndoBar";
import type { Decision } from "@/lib/cw-decisions";
import type { DecisionsResponse as InboxResponse } from "@/lib/decisions";
import { answerGate, type DecisionView } from "@/lib/decision-view";

/** The Chief of staff queue (GET /api/coordinator/decisions?state=open). */
export const DECISIONS_KEY = ["work", "coordinator", "decisions"] as const;
/** The "Needs you" inbox (GET /api/work/decisions): decisions plus approvals, proposals and stalled runs. */
export const INBOX_KEY = ["work", "decisions"] as const;
export const DECISION_UNDO_MS = 10_000;

export type DecisionsResponse = { decisions: Decision[]; counts: { open: number; deferred: number } };
export type AnswerResult = { decision: Decision; repeated?: boolean; op: UndoOp | null };
export type AnswerInput = {
  decision: Pick<DecisionView, "ref" | "risk">;
  answer: string;
  /** The owner's second, explicit tap. Only a Confirm control may set it. */
  confirmed?: boolean;
};

/** A risk-flagged decision reached the write without its second tap. Nothing was sent. */
export class ConfirmNeededError extends Error {
  constructor(ref: string) {
    super(`${ref} needs a second tap to confirm`);
    this.name = "ConfirmNeededError";
  }
}

export const answerPath = (ref: string) => `/api/coordinator/decisions/${encodeURIComponent(ref)}/answer`;

export function useCoordinatorDecisions() {
  return useQuery({
    queryKey: DECISIONS_KEY,
    queryFn: ({ signal }) => api.get<DecisionsResponse>("/api/coordinator/decisions?state=open", signal),
    refetchInterval: 30_000,
  });
}

/** The "Needs you" list (sidebar badge, /decisions, Today, Map, Portfolio, the item page). */
export function useInboxDecisions(enabled = true) {
  // Approvals and workflow proposals change outside work mutations (Hermes events, the chat approval
  // handler), so poll while the app is visible.
  return useQuery({
    queryKey: INBOX_KEY,
    queryFn: () => api.get<InboxResponse>("/api/work/decisions"),
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
}

const refreshWork = (client: QueryClient) =>
  Promise.all([client.invalidateQueries({ queryKey: ["work"] }), client.invalidateQueries({ queryKey: ["activity"] })]);

type Snapshot = { queue: DecisionsResponse | undefined; inbox: InboxResponse | undefined };

/** Take the answered decision out of both lists at once, so the queue, the inbox and the sidebar count agree. */
function removeOptimistically(client: QueryClient, ref: string): Snapshot {
  const queue = client.getQueryData<DecisionsResponse>(DECISIONS_KEY);
  const inbox = client.getQueryData<InboxResponse>(INBOX_KEY);
  if (queue?.decisions.some((d) => d.ref === ref))
    client.setQueryData<DecisionsResponse>(DECISIONS_KEY, {
      decisions: queue.decisions.filter((d) => d.ref !== ref),
      counts: { ...queue.counts, open: Math.max(0, queue.counts.open - 1) },
    });
  if (inbox?.entries.some((e) => e.ref === ref)) {
    const entries = inbox.entries.filter((e) => e.ref !== ref);
    client.setQueryData<InboxResponse>(INBOX_KEY, { entries, count: entries.length });
  }
  return { queue, inbox };
}

export function useAnswerDecision() {
  const client = useQueryClient();
  return useMutation<AnswerResult, Error, AnswerInput, Snapshot | undefined>({
    mutationFn: ({ decision, answer, confirmed }) => {
      const gate = answerGate(decision, answer, confirmed);
      if (gate === "confirm") throw new ConfirmNeededError(decision.ref);
      if (gate === "empty") throw new Error("Answer is empty");
      return api.post<AnswerResult>(answerPath(decision.ref), { answer: answer.trim(), via: "queue", idempotencyKey: crypto.randomUUID() });
    },
    onMutate: async ({ decision, answer, confirmed }) => {
      if (answerGate(decision, answer, confirmed) !== "send") return undefined;
      await Promise.all([client.cancelQueries({ queryKey: DECISIONS_KEY }), client.cancelQueries({ queryKey: INBOX_KEY, exact: true })]);
      return removeOptimistically(client, decision.ref);
    },
    onError: (_error, _input, snapshot) => {
      if (snapshot?.queue) client.setQueryData(DECISIONS_KEY, snapshot.queue);
      if (snapshot?.inbox) client.setQueryData(INBOX_KEY, snapshot.inbox);
    },
    onSettled: () => refreshWork(client),
  });
}

export function useDeferDecision() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ ref, until }: { ref: string; until: string }) =>
      api.post<{ decision: Decision }>(`/api/coordinator/decisions/${encodeURIComponent(ref)}/defer`, { until }),
    onSuccess: () => refreshWork(client),
  });
}

/** What an answered decision leaves behind for ten seconds: the line "D-n answered · choice" and its Undo. */
export type DecisionReceipt = {
  view: DecisionView;
  choice: string;
  op: UndoOp | null;
  /** Where the row sat in its list, so the receipt takes its place instead of jumping. */
  index: number;
  /** False once the ten seconds are over (a receipt that stays on screen then has no Undo). */
  undoable: boolean;
};
export type DecisionNotice = { id: string; text: string; undoLabel?: string; undo: () => Promise<void> };
export type AnswerOptions = { confirmed?: boolean; index?: number };

export type DecisionFlow = ReturnType<typeof useDecisionFlowController>;
/** Shared by a surface that draws the same decisions in two places (the Chief of staff list and detail). */
export const DecisionFlowContext = createContext<DecisionFlow | null>(null);

/**
 * @param keepReceipts a surface that is ABOUT one decision (its page) keeps the receipt after Undo expires;
 *   a list lets it go, because an answered decision no longer needs the owner.
 */
export function useDecisionFlowController({ keepReceipts = false }: { keepReceipts?: boolean } = {}) {
  const client = useQueryClient();
  const mutation = useAnswerDecision();
  const defer = useDeferDecision();
  const { toast } = useToast();
  const [receipts, setReceipts] = useState<Record<string, DecisionReceipt>>({});
  const [pending, setPending] = useState<string[]>([]);
  const [notices, setNotices] = useState<DecisionNotice[]>([]);
  const [deferring, setDeferring] = useState<string[]>([]);
  const inFlight = useRef(new Set<string>());
  const receiptTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const noticeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const undoing = useRef(new Set<string>());
  const undoneOps = useRef(new Set<string>());
  const stagedRefs = useRef(new Set<string>());
  /** Writes staged behind a grace period: committed (not dropped) if the surface unmounts first. */
  const pendingExpiry = useRef(new Map<string, () => void>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const receiptT = receiptTimers.current;
    const noticeT = noticeTimers.current;
    const staged = pendingExpiry.current;
    return () => {
      mounted.current = false;
      receiptT.forEach(clearTimeout);
      receiptT.clear();
      noticeT.forEach(clearTimeout);
      noticeT.clear();
      // Leaving the surface is not Undo: a staged defer still happens.
      staged.forEach((commit) => commit());
      staged.clear();
    };
  }, []);

  function dropReceipt(ref: string) {
    clearTimeout(receiptTimers.current.get(ref));
    receiptTimers.current.delete(ref);
    setReceipts((rows) => {
      if (!rows[ref]) return rows;
      const copy = { ...rows };
      delete copy[ref];
      return copy;
    });
  }
  function addReceipt(receipt: DecisionReceipt) {
    const ref = receipt.view.ref;
    clearTimeout(receiptTimers.current.get(ref));
    setReceipts((rows) => ({ ...rows, [ref]: receipt }));
    receiptTimers.current.set(
      ref,
      setTimeout(() => {
        receiptTimers.current.delete(ref);
        if (keepReceipts) setReceipts((rows) => (rows[ref] ? { ...rows, [ref]: { ...rows[ref], undoable: false } } : rows));
        else dropReceipt(ref);
      }, DECISION_UNDO_MS),
    );
  }

  async function undoOps(ops: readonly UndoOp[]) {
    // Keep only what is not yet undone if a later undo in a batch fails.
    try {
      for (const op of [...ops].reverse()) {
        if (undoneOps.current.has(op.id)) continue;
        await api.post(`/api/work/ops/${encodeURIComponent(op.id)}/undo`);
        undoneOps.current.add(op.id);
      }
    } finally {
      await refreshWork(client);
    }
  }

  /**
   * Send one answer. Resolves with the result, or null when nothing was sent (a risky answer without its second
   * tap, a repeat tap, a staged defer) or the write failed (already said in a toast).
   */
  async function answer(view: DecisionView, choice: string, options: AnswerOptions = {}): Promise<AnswerResult | null> {
    const text = choice.trim();
    if (answerGate(view, text, options.confirmed) !== "send") return null;
    if (inFlight.current.has(view.ref) || stagedRefs.current.has(view.ref)) return null;
    inFlight.current.add(view.ref);
    setPending((refs) => [...refs, view.ref]);
    try {
      const result = await mutation.mutateAsync({ decision: view, answer: text, confirmed: options.confirmed });
      if (mounted.current) addReceipt({ view, choice: text, op: result.op, index: options.index ?? 0, undoable: !!result.op });
      return result;
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't answer. Try again.", "danger");
      return null;
    } finally {
      inFlight.current.delete(view.ref);
      if (mounted.current) setPending((refs) => refs.filter((ref) => ref !== view.ref));
    }
  }

  /** Take an answer back: the decision is open again. */
  async function undo(ref: string): Promise<boolean> {
    const receipt = receipts[ref];
    if (!receipt?.op || undoing.current.has(ref)) return false;
    undoing.current.add(ref);
    try {
      await undoOps([receipt.op]);
      if (mounted.current) dropReceipt(ref);
      toast("Undone");
      return true;
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't undo. Try again.", "danger");
      return false;
    } finally {
      undoing.current.delete(ref);
    }
  }

  function removeNotice(id: string) {
    clearTimeout(noticeTimers.current.get(id));
    noticeTimers.current.delete(id);
    setNotices((rows) => rows.filter((n) => n.id !== id));
  }
  /** A ten-second line with Undo for something that is not one decision's receipt: a staged defer, a batch. */
  function showUndo(text: string, action: () => Promise<void>, options: { onExpire?: () => void; undoLabel?: string } = {}) {
    const id = crypto.randomUUID();
    const run = async () => {
      if (undoing.current.has(id)) return;
      undoing.current.add(id);
      clearTimeout(noticeTimers.current.get(id));
      pendingExpiry.current.delete(id);
      try {
        await action();
        removeNotice(id);
        toast("Undone");
      } catch (error) {
        toast(error instanceof Error ? error.message : "Couldn't undo. Try again.", "danger");
      } finally {
        undoing.current.delete(id);
      }
    };
    setNotices((rows) => [...rows, { id, text, undoLabel: options.undoLabel, undo: run }]);
    if (options.onExpire) pendingExpiry.current.set(id, options.onExpire);
    noticeTimers.current.set(
      id,
      setTimeout(() => {
        removeNotice(id);
        pendingExpiry.current.delete(id);
        options.onExpire?.();
      }, DECISION_UNDO_MS),
    );
    return run;
  }

  function stageDefer(ref: string, until: string) {
    if (stagedRefs.current.has(ref) || inFlight.current.has(ref)) return;
    stagedRefs.current.add(ref);
    setDeferring((refs) => [...refs, ref]);
    const finish = () => {
      stagedRefs.current.delete(ref);
      if (mounted.current) setDeferring((refs) => refs.filter((r) => r !== ref));
    };
    // The defer endpoint has no undo route of its own. A cancellable grace period is a real Undo
    // without pretending an API exists.
    showUndo(
      `Deferring ${ref} in 10 s`,
      async () => {
        finish();
      },
      {
        onExpire: () => {
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
      },
    );
  }

  const busy = (ref: string) => pending.includes(ref) || deferring.includes(ref);
  return {
    receipts,
    pending,
    deferring,
    notices,
    busy,
    answer,
    undo,
    undoOps,
    addReceipt,
    dropReceipt,
    showUndo,
    stageDefer,
    toast,
    isAnswering: mutation.isPending,
  };
}

/** The surface's shared flow when one is provided (the Chief of staff panel), else one of its own. */
export function useDecisionFlow(options?: { keepReceipts?: boolean }) {
  const shared = useContext(DecisionFlowContext);
  const local = useDecisionFlowController(options);
  return { flow: shared ?? local, shared: !!shared };
}

/**
 * A list with its receipts back in place: an answered row leaves the data at once (optimistic), and its
 * receipt stands where the row was until Undo expires.
 */
export function withReceipts<T extends { ref: string }>(rows: readonly T[], receipts: Record<string, DecisionReceipt>): (T | DecisionReceipt)[] {
  const out: (T | DecisionReceipt)[] = rows.filter((row) => !receipts[row.ref]);
  const placed = Object.values(receipts).sort((a, b) => a.index - b.index);
  for (const receipt of placed) out.splice(Math.min(receipt.index, out.length), 0, receipt);
  return out;
}
export const isReceipt = (row: unknown): row is DecisionReceipt => !!row && typeof row === "object" && "choice" in row && "view" in row;
