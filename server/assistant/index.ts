import "server-only";
import { HttpError } from "@/server/http/errors";
import { isLocalRun, isLocalSession, type AssistantBackend } from "@/lib/assistant";
import type { CurrentUser } from "@/server/auth";
import type { SessionSummary } from "@/lib/hermes";
import { isConfigured } from "@/integrations/store";
import * as hermes from "@/integrations/hermes/service";
import * as local from "./local";
import { backendAvailable, defaultBackend } from "./settings";
import { markIndexStale, noteIndexedSession, syncIndexedTitle } from "@/server/work/conversation-index";

/**
 * One chat surface, two backends. Conversation and run ids say which backend
 * owns them (loc_/lrn_ are Claude-direct; everything else is Hermes), so the
 * routes, the web chat and the phone app don't need to care.
 */
export async function listSessions(user: CurrentUser, opts: hermes.SessionListOptions = {}) {
  const localSessions = (opts.offset ?? 0) === 0 ? local.listLocalSessions(user, opts) : [];
  const unavailable: string[] = [];
  let remote: SessionSummary[] = [];
  let nextOffset: number | null = null;
  if (isConfigured("hermes")) {
    try {
      const page = await hermes.listSessionPage(user, opts);
      remote = page.sessions;
      nextOffset = page.nextOffset;
      // A routed profile that didn't answer makes this a partial list: flag it so the
      // conversation index keeps its cached entries instead of dropping them.
      for (const p of page.unavailableProfiles ?? []) unavailable.push(`Hermes (${p})`);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      // Partial success is explicit and retryable, never a terminal empty list.
      if (!localSessions.length) throw err;
      unavailable.push("Hermes");
      nextOffset = opts.offset ?? 0;
    }
  }
  const sessions = [...remote, ...localSessions].sort((a, b) => (b.lastActiveAt ?? b.startedAt ?? "").localeCompare(a.lastActiveAt ?? a.startedAt ?? ""));
  return { sessions, unavailable, nextOffset };
}

/** Just your Claude-direct conversations (local, no network): merged live into cached lists. */
export const listLocalConversations = (user: CurrentUser) => local.listLocalSessions(user, {});

/** Keep the persisted conversation index (server/work/conversation-index.ts) in step with changes made here. */
function indexed<T extends SessionSummary>(user: CurrentUser, s: T, opts: { insert?: boolean } = {}): T {
  try {
    noteIndexedSession(user.id, s, opts);
    if (!s.readOnly) syncIndexedTitle(user.id, s);
  } catch {
    // The index is a cache; the next refresh corrects it.
  }
  return s;
}

/** `profile`: the routed Hermes profile for this conversation (Settings → Agents); ignored for Claude. */
export async function createSession(user: CurrentUser, title?: string, backend?: AssistantBackend, profile?: string | null) {
  const b = backend ?? defaultBackend();
  if (!backendAvailable(b)) throw new HttpError(409, "backend_unavailable", b === "claude" ? "Claude isn't set up yet." : "Hermes isn't connected.");
  return b === "claude" ? local.createLocalSession(user, title) : indexed(user, await hermes.createSession(user, title, profile));
}

// Reads refresh that conversation's row in the persisted index (and its tree title) without adding new rows.
export const getSessionDetail = async (user: CurrentUser, id: string) => {
  if (isLocalSession(id)) return local.localSessionDetail(user, id);
  const d = await hermes.getSessionDetail(user, id);
  indexed(user, d.session, { insert: false });
  return d;
};

/** One conversation's summary (access-checked), without the transcript or fork lineage. */
export const getSessionSummary = async (user: CurrentUser, id: string) =>
  isLocalSession(id) ? local.localSessionDetail(user, id).session : indexed(user, await hermes.getSessionSummary(user, id), { insert: false });

export const updateSession = async (user: CurrentUser, id: string, patch: Parameters<typeof hermes.updateSession>[2], correlationId: string) =>
  isLocalSession(id) ? local.updateLocalSession(user, id, patch, correlationId) : indexed(user, await hermes.updateSession(user, id, patch, correlationId));

export const forkSession = async (user: CurrentUser, id: string, input: hermes.ForkInput, correlationId: string) => {
  if (isLocalSession(id)) return local.forkLocalSession(user, id, input, correlationId);
  const result = await hermes.forkSession(user, id, input, correlationId);
  if (result.session?.id) indexed(user, result.session);
  try {
    // A fork may start its first run inside Hermes: revalidate on the next list read.
    markIndexStale(user.id);
  } catch {
    /* cache only */
  }
  return result;
};

export const startRun = async (user: CurrentUser, r: hermes.StartRunRequest, correlationId: string) => {
  if (isLocalSession(r.sessionId)) return local.startLocalRun(user, r, correlationId);
  const run = await hermes.startRun(user, r, correlationId);
  try {
    // Its title/recency will change upstream: the next list read revalidates in the background.
    markIndexStale(user.id);
  } catch {
    /* cache only */
  }
  return run;
};

export const getRun = (user: CurrentUser, runId: string) => (isLocalRun(runId) ? Promise.resolve(local.getLocalRun(user, runId)) : hermes.getRun(user, runId));

export const stopRun = (user: CurrentUser, runId: string, correlationId: string) =>
  isLocalRun(runId) ? Promise.resolve(local.stopLocalRun(user, runId, correlationId)) : hermes.stopRun(user, runId, correlationId);

export const reconcileRun = (runId: string) => (isLocalRun(runId) ? Promise.resolve(local.reconcileLocalRun(runId)) : hermes.reconcileRun(runId));

/** `format: "agui"` streams AG-UI events (Hermes runs only; Claude-direct keeps Jarvis events, which the client also reads). */
export function relayRunEvents(user: CurrentUser, runId: string, lastSeq: string | undefined, signal: AbortSignal, format: "jarvis" | "agui" = "jarvis") {
  return isLocalRun(runId) ? local.relayLocalEvents(user, runId, lastSeq, signal) : hermes.relayRunEvents(user, runId, lastSeq, signal, { format });
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
