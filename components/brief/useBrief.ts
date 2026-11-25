"use client";

import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newIdempotencyKey } from "@/lib/client/api";
import type {
  BriefAssistTarget,
  BriefFeedbackView,
  BriefImproveView,
  BriefImprovementView,
  BriefNoteView,
  BriefSettings,
  BriefVerdict,
  BriefView,
} from "@/lib/brief";

export const BRIEF_KEY = ["brief"] as const;
export const BRIEF_NOTES_KEY = ["brief", "notes"] as const;

const BUILDING = new Set(["queued", "building"]);
const WORKING = new Set(["running", "idle"]);

/** An agent the person started from here is still on something: its state is worth checking more often. */
function agentBusy(v: BriefView) {
  return v.improve?.open.some((o) => WORKING.has(o.live)) || v.deck?.some((d) => d.rows.some((r) => r.assist?.request && WORKING.has(r.assist.request.live)));
}

/** Today's brief. Reads are cheap (no model, cached sources); while a build is running it polls for the result. */
export function useBrief(enabled = true) {
  return useQuery({
    queryKey: BRIEF_KEY,
    queryFn: () => api.get<BriefView>("/api/brief"),
    enabled,
    staleTime: 30_000,
    refetchInterval: (q) => {
      const v = q.state.data;
      if (v && BUILDING.has(v.build.state)) return 2500;
      return v && agentBusy(v) ? 8000 : 5 * 60_000;
    },
  });
}

/** What Undo puts back: the previous feedback on a target, or a proposal's previous state. */
type UndoOp =
  | { kind: "feedback"; briefId: string; targetKey: string; verdict: BriefVerdict | null; note?: string }
  | { kind: "note_state"; id: string; state: BriefNoteView["state"] }
  | { kind: "improve"; id: string };
/** One pending Undo at a time, shown as a toast with an action. */
export type Undo = { message: string; op: UndoOp } | null;

type FeedbackResult = { feedback: BriefFeedbackView[]; previous: BriefFeedbackView | null };

const postFeedback = (briefId: string, targetKey: string, verdict: BriefVerdict | null, note?: string) =>
  api.post<FeedbackResult>("/api/brief/feedback", { briefId, targetKey, verdict, ...(note ? { note } : {}) });
const noteUrl = (id: string) => `/api/brief/notes/${encodeURIComponent(id)}`;

export function useBriefActions() {
  const qc = useQueryClient();
  const [undo, setUndo] = useState<Undo>(null);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((e: unknown) => setError((e as Error).message || "That didn't work"), []);
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: BRIEF_KEY });
    void qc.invalidateQueries({ queryKey: BRIEF_NOTES_KEY });
  }, [qc]);
  const setFeedback = useCallback((feedback: BriefFeedbackView[]) => qc.setQueryData<BriefView>(BRIEF_KEY, (v) => (v ? { ...v, feedback } : v)), [qc]);

  const build = useMutation({
    mutationFn: (opts: { budgetOverride?: boolean } = {}) =>
      api.post<BriefView>("/api/brief/build", { clientKey: newIdempotencyKey("brief").slice(0, 60), ...opts }),
    onSuccess: (v) => qc.setQueryData(BRIEF_KEY, v),
    onError: fail,
  });

  const settings = useMutation({
    mutationFn: (patch: Partial<Omit<BriefSettings, "share">> & { share?: Partial<BriefSettings["share"]> }) =>
      api.put<{ settings: BriefSettings }>("/api/brief/settings", patch),
    onSuccess: refresh,
    onError: fail,
  });

  /** "Improve": hand a change to an agent. Undo stops it and takes the item back out. */
  const improve = useMutation({
    mutationFn: (input: { text: string; areaId?: string | null }) =>
      api.post<{ improvement: BriefImprovementView; improve: BriefImproveView }>("/api/brief/improve", {
        ...input,
        clientKey: newIdempotencyKey("improve").slice(0, 60),
      }),
    onSuccess: (r) => {
      qc.setQueryData<BriefView>(BRIEF_KEY, (v) => (v ? { ...v, improve: r.improve } : v));
      setUndo({ message: "Agent started", op: { kind: "improve", id: r.improvement.id } });
    },
  });

  /** The sparkle on a row: an agent looks into that one task. Undo stops it and takes it back out. */
  const assist = useMutation({
    mutationFn: (target: BriefAssistTarget) =>
      api.post<{ improvement: BriefImprovementView; improve: BriefImproveView }>("/api/brief/assist", {
        target,
        clientKey: newIdempotencyKey("assist").slice(0, 60),
      }),
    onSuccess: (r, target) => {
      const request = { id: r.improvement.id, live: r.improvement.live, sessionId: r.improvement.sessionId };
      qc.setQueryData<BriefView>(BRIEF_KEY, (v) =>
        v
          ? {
              ...v,
              improve: r.improve,
              deck: v.deck.map((d) => ({
                ...d,
                rows: d.rows.map((row) =>
                  row.assist && row.assist.target.kind === target.kind && row.assist.target.id === target.id
                    ? { ...row, assist: { ...row.assist, request } }
                    : row,
                ),
              })),
            }
          : v,
      );
      setUndo({ message: "Agent started", op: { kind: "improve", id: r.improvement.id } });
    },
    onError: fail,
  });

  /** `quiet` saves without offering Undo (adding a note to feedback the person just gave). */
  const sendFeedback = useCallback(
    async (briefId: string, targetKey: string, verdict: BriefVerdict | null, note?: string, quiet = false) => {
      try {
        const r = await postFeedback(briefId, targetKey, verdict, note);
        setFeedback(r.feedback);
        if (!quiet)
          setUndo({
            message: verdict === null ? "Feedback removed" : verdict === "up" ? "Noted: right call" : "Noted: wrong call",
            op: { kind: "feedback", briefId, targetKey, verdict: r.previous?.verdict ?? null, note: r.previous?.note },
          });
      } catch (e) {
        fail(e);
      }
    },
    [fail, setFeedback],
  );

  const patchNote = useCallback(
    async (note: BriefNoteView, state: BriefNoteView["state"]) => {
      try {
        await api.patch(noteUrl(note.id), { state });
        refresh();
        setUndo({
          message: state === "active" ? "Kept" : "Dismissed",
          op: { kind: "note_state", id: note.id, state: note.state },
        });
      } catch (e) {
        fail(e);
      }
    },
    [fail, refresh],
  );

  /** Tick or untick a small step on a card. Shown at once; put back if the save fails. Unticking is the undo. */
  const tick = useCallback(
    async (briefId: string, blockId: string, index: number, done: boolean) => {
      const set = (next: (cur: number[]) => number[]) =>
        qc.setQueryData<BriefView>(BRIEF_KEY, (v) =>
          v ? { ...v, brief: { ...v.brief, blocks: v.brief.blocks.map((b) => (b.id === blockId ? { ...b, done: next(b.done ?? []) } : b)) } } : v,
        );
      const apply = (on: boolean) => set((cur) => (on ? [...new Set([...cur, index])].sort((a, b) => a - b) : cur.filter((i) => i !== index)));
      apply(done);
      try {
        const r = await api.post<{ blockId: string; done: number[] }>("/api/brief/steps", { briefId, blockId, index, done });
        set(() => r.done);
      } catch (e) {
        apply(!done);
        fail(e);
      }
    },
    [fail, qc],
  );

  const runUndo = useCallback(
    async (op: UndoOp) => {
      setUndo(null);
      try {
        if (op.kind === "feedback") setFeedback((await postFeedback(op.briefId, op.targetKey, op.verdict, op.note)).feedback);
        else if (op.kind === "improve") await api.del(`/api/brief/improve/${encodeURIComponent(op.id)}`);
        else await api.patch(noteUrl(op.id), { state: op.state });
        refresh();
      } catch (e) {
        fail(e);
      }
    },
    [fail, refresh, setFeedback],
  );

  return { build, settings, improve, assist, sendFeedback, patchNote, tick, undo, setUndo, runUndo, error, setError };
}

export type BriefActions = ReturnType<typeof useBriefActions>;
