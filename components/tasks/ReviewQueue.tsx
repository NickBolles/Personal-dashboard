"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, EmptyState, useToast } from "@/components/ui";
import { UNDO_VISIBLE_MS } from "@/components/work/UndoBar";
import { api } from "@/lib/client/api";
import { TaskList, useTaskList } from "./TaskList";
import "@/components/work/task-chat.css";

type Reviewed = { reviewed: { id: string; opId: string | null }[]; skipped: { id: string; title: string; reason: string }[] };

/**
 * The review queue: finished work, grouped by project, each row with its result line and pull request state.
 * Several can be marked reviewed together behind one confirm, with Undo. Nothing is closed without that tap.
 */
export function ReviewQueue({ scope = "all" }: { scope?: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const list = useTaskList(scope, "review");
  const [selecting, setSelecting] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<{ ops: string[]; count: number; skipped: Reviewed["skipped"] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const refresh = () => qc.invalidateQueries({ queryKey: ["work"] });
  const present = new Set(list.data?.groups.flatMap((g) => g.rows.map((r) => r.id)) ?? []);
  const chosen = ids.filter((id) => present.has(id));
  const mark = useMutation({
    mutationFn: () => api.post<Reviewed>("/api/work/tasks/review", { ids: chosen }),
    onSuccess: (out) => {
      setConfirm(false);
      setIds([]);
      setSelecting(false);
      setDone({ ops: out.reviewed.flatMap((r) => (r.opId ? [r.opId] : [])), count: out.reviewed.length, skipped: out.skipped });
      if (timer.current) clearTimeout(timer.current);
      // A list of what was left open stays until it is read; a plain receipt goes with its Undo.
      if (!out.skipped.length) timer.current = setTimeout(() => setDone(null), UNDO_VISIBLE_MS);
      void refresh();
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't mark them reviewed. Try again.", "danger"),
  });
  const undo = useMutation({
    mutationFn: async (ops: string[]) => {
      for (const op of [...ops].reverse()) await api.post(`/api/work/ops/${encodeURIComponent(op)}/undo`);
    },
    onSuccess: () => {
      setDone(null);
      toast("Undone");
    },
    onError: (error) => toast(error instanceof Error ? error.message : "Couldn't undo. Try again.", "danger"),
    onSettled: () => void refresh(),
  });
  const review = list.data?.review;
  return (
    <div className="tl-page" data-testid="review-queue">
      <header className="tl-head">
        <div className="min-w-0">
          <Link href="/resume" className="tl-back">
            ← In flight
          </Link>
          <h1 className="tl-h1">Ready for review</h1>
          {review ? (
            <p className="tl-quiet">
              {review.count === 1 ? "1 task" : `${review.count} tasks`} · {review.projects === 1 ? "1 project" : `${review.projects} projects`}
            </p>
          ) : null}
        </div>
        {review ? (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={selecting}
            onClick={() => {
              setSelecting((v) => !v);
              setIds([]);
            }}
          >
            {selecting ? "Cancel" : "Select"}
          </Button>
        ) : null}
      </header>
      {done ? (
        <div className="tl-bar" role="status" data-testid="review-receipt">
          <p>
            {done.count === 1 ? "1 task marked reviewed" : `${done.count} tasks marked reviewed`}
            {done.skipped.length ? ` · ${done.skipped.length} left open: ${done.skipped.map((s) => `${s.title} (${s.reason})`).join("; ")}` : ""}
          </p>
          {done.ops.length ? (
            <Button size="sm" variant="ghost" loading={undo.isPending} onClick={() => undo.mutate(done.ops)}>
              Undo
            </Button>
          ) : null}
          {done.skipped.length ? (
            <Button size="sm" variant="ghost" onClick={() => setDone(null)}>
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
      <TaskList
        scope={scope}
        view="review"
        select={selecting ? { ids: chosen, toggle: (id) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])) } : undefined}
        empty={<EmptyState title="Nothing to review" />}
      />
      {selecting ? (
        <div className="tl-bar" data-testid="review-bar">
          <p>{chosen.length ? `${chosen.length} selected` : "Select the tasks you have looked at"}</p>
          <Button size="sm" variant="primary" disabled={!chosen.length} onClick={() => setConfirm(true)}>
            Mark {chosen.length || ""} reviewed
          </Button>
        </div>
      ) : null}
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={chosen.length === 1 ? "Mark 1 task reviewed?" : `Mark ${chosen.length} tasks reviewed?`}
        description="This closes them. You can undo it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={mark.isPending} onClick={() => mark.mutate()}>
              Mark reviewed
            </Button>
          </>
        }
      />
    </div>
  );
}
