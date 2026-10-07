import "server-only";
import { HttpError } from "@/server/http/errors";
import { isLocalRun, isLocalSession, type AssistantBackend } from "@/lib/assistant";
import type { CurrentUser } from "@/server/auth";
import type { SessionSummary } from "@/lib/hermes";
import { isConfigured } from "@/integrations/store";
import * as hermes from "@/integrations/hermes/service";
import * as local from "./local";
import { backendAvailable, defaultBackend } from "./settings";

/**
 * One chat surface, two backends. Conversation and run ids say which backend
 * owns them (loc_/lrn_ are Claude-direct; everything else is Hermes), so the
 * routes, the web chat and the phone app don't need to care.
 */
export async function listSessions(user: CurrentUser, opts: { includeArchived?: boolean } = {}) {
  const localSessions = local.listLocalSessions(user, opts);
  const unavailable: string[] = [];
  let remote: SessionSummary[] = [];
  if (isConfigured("hermes")) {
    try {
      remote = await hermes.listSessions(user, opts);
    } catch (err) {
      // With Claude conversations to show, a slow or down Hermes doesn't blank the list.
      if (!localSessions.length) throw err;
      unavailable.push("Hermes");
    }
  }
  const sessions = [...remote, ...localSessions].sort((a, b) => (b.lastActiveAt ?? b.startedAt ?? "").localeCompare(a.lastActiveAt ?? a.startedAt ?? ""));
  return { sessions, unavailable };
}

export async function createSession(user: CurrentUser, title?: string, backend?: AssistantBackend) {
  const b = backend ?? defaultBackend();
  if (!backendAvailable(b)) throw new HttpError(409, "backend_unavailable", b === "claude" ? "Claude isn't set up yet." : "Hermes isn't connected.");
  return b === "claude" ? local.createLocalSession(user, title) : hermes.createSession(user, title);
}

export const getSessionDetail = (user: CurrentUser, id: string) =>
  isLocalSession(id) ? Promise.resolve(local.localSessionDetail(user, id)) : hermes.getSessionDetail(user, id);

export const updateSession = (user: CurrentUser, id: string, patch: Parameters<typeof hermes.updateSession>[2], correlationId: string) =>
  isLocalSession(id) ? Promise.resolve(local.updateLocalSession(user, id, patch, correlationId)) : hermes.updateSession(user, id, patch, correlationId);

export const forkSession = (user: CurrentUser, id: string, input: hermes.ForkInput, correlationId: string) =>
  isLocalSession(id) ? local.forkLocalSession(user, id, input, correlationId) : hermes.forkSession(user, id, input, correlationId);

export const startRun = (user: CurrentUser, r: hermes.StartRunRequest, correlationId: string) =>
  isLocalSession(r.sessionId) ? local.startLocalRun(user, r, correlationId) : hermes.startRun(user, r, correlationId);

export const getRun = (user: CurrentUser, runId: string) => (isLocalRun(runId) ? Promise.resolve(local.getLocalRun(user, runId)) : hermes.getRun(user, runId));

export const stopRun = (user: CurrentUser, runId: string, correlationId: string) =>
  isLocalRun(runId) ? Promise.resolve(local.stopLocalRun(user, runId, correlationId)) : hermes.stopRun(user, runId, correlationId);

export const reconcileRun = (runId: string) => (isLocalRun(runId) ? Promise.resolve(local.reconcileLocalRun(runId)) : hermes.reconcileRun(runId));

export function relayRunEvents(user: CurrentUser, runId: string, lastSeq: string | undefined, signal: AbortSignal) {
  return isLocalRun(runId) ? local.relayLocalEvents(user, runId, lastSeq, signal) : hermes.relayRunEvents(user, runId, lastSeq, signal);
}

export function respondApproval(user: CurrentUser, runId: string, body: Parameters<typeof hermes.respondApproval>[2], correlationId: string) {
  if (isLocalRun(runId)) throw new HttpError(400, "unsupported", "Claude conversations don't ask for approvals.");
  return hermes.respondApproval(user, runId, body, correlationId);
}

export function steerRun(user: CurrentUser, runId: string, input: string, correlationId: string) {
  if (isLocalRun(runId)) throw new HttpError(501, "unsupported", "Claude can't be steered mid-answer. Stop it and send a new message.");
  return hermes.steerRun(user, runId, input, correlationId);
}

export { sessionAccess } from "@/integrations/hermes/service";
