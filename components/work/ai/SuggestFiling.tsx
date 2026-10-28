"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, useToast } from "@/components/ui";
import { useAccess } from "@/components/access";
import { ACTIVE_JOB_STATES, type AiFilingState, type AiFilingSuggestion, type JobView } from "@/lib/ai";

export type { AiFilingSuggestion };

const KEY = ["work", "ai-filing"];
const newKey = () => `fs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The latest AI filing suggestions (sessionId → suggestion with a destination). */
export function useAiFiling() {
  const { can } = useAccess();
  const allowed = can("work.ai") && can("hermes.chat");
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<AiFilingState>("/api/work/conversations/suggest"), enabled: allowed });
  const map: Record<string, AiFilingSuggestion> = {};
  for (const s of q.data?.suggestions ?? []) if (s.itemId) map[s.sessionId] = s;
  return { allowed, map };
}

/**
 * "✦ Suggest with AI" for the unfiled list: on demand only (never automatic),
 * one triage-tier job on the shared AI budget. Finance-looking titles and
 * AI-excluded areas never go to the model (server-side). The answer replaces
 * the word-match suggestion on each row; filing is still one tap by you.
 */
export function SuggestWithAi({ allowed }: { allowed: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!allowed) return null;
  const start = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ job: JobView; asked: number; excluded: number }>("/api/work/conversations/suggest", { clientKey: newKey() });
      if (r.excluded) toast(`${r.excluded} left out: they look like finance or contain a credential`, "warn");
      // Poll the job (triage tier: seconds, capped at ~2 minutes) from this handler; no effect loops.
      let job: JobView | null = r.job;
      for (let i = 0; i < 60 && job && ACTIVE_JOB_STATES.includes(job.state) && job.state !== "budget_blocked"; i++) {
        await sleep(2_000);
        const s = await api.get<AiFilingState>("/api/work/conversations/suggest");
        qc.setQueryData(KEY, s);
        job = s.job && s.job.id === r.job.id ? s.job : job;
      }
      if (job?.state === "succeeded") {
        const n = (qc.getQueryData<AiFilingState>(KEY)?.suggestions ?? []).filter((s) => s.itemId).length;
        toast(n ? `AI suggested a home for ${n} conversation${n === 1 ? "" : "s"}` : "AI found no clear home for these", n ? "ok" : "warn");
      } else if (job?.state === "budget_blocked") toast("Today's AI budget is used up (Settings → AI).", "warn");
      else if (job && !ACTIVE_JOB_STATES.includes(job.state)) toast(job.errorMessage || "AI couldn't suggest destinations. Try again later.", "warn");
      else toast("Still working: suggestions will appear here when they're ready.", "warn");
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="sm"
      variant="ghost"
      busy={busy}
      onClick={start}
      title="One cheap AI pass over these titles (shared $5/day AI budget). Finance stays out."
      data-testid="suggest-ai"
    >
      <span aria-hidden="true" className="text-violet">
        ✦
      </span>{" "}
      {busy ? "Suggesting…" : "Suggest with AI"}
    </Button>
  );
}
