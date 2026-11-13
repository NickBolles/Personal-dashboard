"use client";

/**
 * The Chief of staff queue reads and answers decisions through the one shared flow
 * (components/decisions/useAnswerDecision.ts). This module keeps the queue's import path for its callers
 * (GlobalCoordinator, ItemCard) and the panel's own option type.
 */
export {
  DECISIONS_KEY,
  DECISION_UNDO_MS,
  DecisionFlowContext,
  useAnswerDecision,
  useCoordinatorDecisions,
  useDecisionFlow,
  useDecisionFlowController,
  useDeferDecision,
  type AnswerResult,
  type DecisionFlow,
  type DecisionNotice,
  type DecisionsResponse,
} from "@/components/decisions/useAnswerDecision";

export type NeedsOpenOptions = { arm?: string; ask?: boolean };
