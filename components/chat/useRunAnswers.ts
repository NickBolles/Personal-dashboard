"use client";

import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { ApprovalRequest } from "@/lib/hermes";
import type { RunState } from "@/lib/client/run-state";

/**
 * The owner's answers to a run that is waiting on them: approve or deny a command, or answer a question.
 * One implementation for every surface that shows a live run (the chat page, the Chief of staff panel), so an
 * approval means the same request wherever it is tapped.
 *
 * Both reject when the request fails: the card that called them shows "Couldn't send…" with Retry.
 * `announce` says the outcome to a screen reader where the surface has a live region.
 */
export function useRunAnswers(state: RunState, announce: (text: string) => void = () => {}) {
  const qc = useQueryClient();
  const answerApproval = async (choice: ApprovalRequest["choices"][number]) => {
    if (!state.runId) return;
    try {
      await api.post(`/api/hermes/runs/${encodeURIComponent(state.runId)}/approval`, { choice, requestId: state.approval?.requestId });
      announce(choice === "deny" ? "Denied" : "Approved");
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    } catch (err) {
      // The approval card shows "Couldn't send your approval" + Retry, with this message folded under Details.
      announce(choice === "deny" ? "Couldn't send your denial" : "Couldn't send your approval");
      throw err;
    }
  };
  const answerClarify = async (answer: string) => {
    const runId = state.runId;
    const requestId = state.clarify?.requestId;
    if (!runId || !requestId) return;
    try {
      await api.post(`/api/hermes/runs/${encodeURIComponent(runId)}/clarify`, { answer, requestId });
      announce("Answer sent");
    } catch (err) {
      announce("Couldn't send your answer");
      throw err;
    }
  };
  return { answerApproval, answerClarify };
}
