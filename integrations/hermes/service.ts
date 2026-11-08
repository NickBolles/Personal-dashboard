import "server-only";
import { and, desc, eq, inArray, isNotNull, notInArray, or } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { audit } from "@/server/audit";
import { config } from "@/server/config";
import { processSingleton } from "@/server/singleton";
import { acquireHermesSlot, withHermesLane, type Slot } from "@/server/http/hermes-budget";
import { HttpError, UpstreamError } from "@/server/http/errors";
import { formatSse, SseParser } from "@/lib/sse";
import { isTerminal, type RunEvent, type RunView, type SessionSummary } from "@/lib/hermes";
import { foldSubagents, isSubagentSession } from "@/lib/session-children";
import { getOwner, type CurrentUser } from "@/server/auth";
import { HermesExecutionClient, HermesSessionClient, type HermesApprovalBody, type HermesClarifyBody, type HermesConn } from "./client";
import { connForProfile } from "@/server/agents/routing";
import { HermesAguiTranslator } from "@/server/agui/hermes";
import { messagesToTimeline, normalizeApproval, normalizeClarify, normalizeRunEvent, normalizeSession } from "./normalize";
import { SYNC_SESSION_SOURCE } from "./structured";
import { RUN_TERMINAL, runEventSchema, type HermesRunStatus } from "./types";
import { executionParent, executionCompletionState, upsertExecution } from "@/server/chat/execution-store";

const db = () => getDb();

function metaFor(ids: string[]) {
  if (!ids.length) return new Map<string, typeof schema.sessionMeta.$inferSelect>();
  const rows = db().select().from(schema.sessionMeta).where(inArray(schema.sessionMeta.sessionId, ids)).all();
  return new Map(rows.map((r) => [r.sessionId, r]));
}

function activeRunsFor(ids: string[]) {
  if (!ids.length) return new Map<string, typeof schema.runs.$inferSelect>();
  const rows = db()
    .select()
    .from(schema.runs)
    .where(and(inArray(schema.runs.sessionId, ids), notInArray(schema.runs.status, [...RUN_TERMINAL])))
    .all();
  return new Map(rows.map((r) => [r.sessionId, r]));
}

type Meta = typeof schema.sessionMeta.$inferSelect;

/** The Hermes profile a session lives on (null = default), recorded when Jarvis created it. */
export function sessionProfile(id: string) {
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && seen.size < 50 && !seen.has(current)) {
    seen.add(current);
    const m = metaFor([current]).get(current);
    if (m?.hermesProfile) return m.hermesProfile;
    current = m?.parentSessionId ?? null;
  }
  return null;
}

/** Sessions and runs keep using the profile they were created on (Settings → Agents). */
const connForSession = (id: string): HermesConn => connForProfile(sessionProfile(id));
const connForRun = (row: { hermesProfile: string | null } | undefined): HermesConn => connForProfile(row?.hermesProfile ?? null);

/**
 * Conversations are private to the person who started them. Sessions Jarvis
 * didn't create (made in Hermes directly) belong to the owner. A shared one is
 * readable (and forkable) by everyone who can chat; only its owner writes to it.
 */
function access(user: CurrentUser, m: Meta | undefined, ownerId = getOwner()?.id): "write" | "read" | null {
  const owner = m?.userId ?? ownerId;
  if (owner === user.id) return "write";
  return m?.shared ? "read" : null;
}

export function sessionAccess(user: CurrentUser, id: string) {
  const seen = new Set<string>();
  let current = id;
  while (seen.size < 50 && !seen.has(current)) {
    seen.add(current);
    const m = metaFor([current]).get(current);
    if (!m?.parentSessionId) return access(user, m);
    current = m.parentSessionId;
  }
  return null;
}

/**
 * Access for a whole list with one meta query; only rows that are children (parentSessionId)
 * walk their parent chain. Per-row lookups made palette/@ search ~7x slower on 2k sessions.
 */
function accessFor(user: CurrentUser, ids: string[], meta = metaFor(ids)) {
  const ownerId = getOwner()?.id;
  const out = new Map<string, "write" | "read" | null>();
  for (const id of ids) {
    const m = meta.get(id);
    out.set(id, m?.parentSessionId ? sessionAccess(user, id) : access(user, m, ownerId));
  }
  return out;
}

/** Profile from an already-loaded meta row; walks parents only for children without their own profile. */
function profileFrom(id: string, m: Meta | undefined) {
  if (m?.hermesProfile) return m.hermesProfile;
  return m?.parentSessionId ? sessionProfile(id) : null;
}

/** The rows of `list` this person may see (one meta query for the whole list). */
export function visibleSessions<T extends { id: string }>(user: CurrentUser, list: T[]): T[] {
  if (!list.length) return list;
  const acc = accessFor(
    user,
    list.map((s) => s.id),
  );
  return list.filter((s) => acc.get(s.id));
}

function assertAccess(user: CurrentUser, id: string, need: "read" | "write") {
  const a = sessionAccess(user, id);
  if (!a) throw new HttpError(404, "session_not_found", "Conversation not found");
  if (need === "write" && a !== "write") throw new HttpError(403, "read_only", "This conversation was shared with you read-only. Fork it to continue.");
}

function decorate(list: SessionSummary[], user?: CurrentUser): SessionSummary[] {
  const ids = list.map((s) => s.id);
  const meta = metaFor(ids);
  const runs = activeRunsFor(ids);
  const acc = user ? accessFor(user, ids, meta) : null;
  const visible = acc ? list.filter((s) => acc.get(s.id)) : list;
  return visible.map((s) => {
    const m = meta.get(s.id);
    const r = runs.get(s.id);
    return {
      ...s,
      shared: Boolean(m?.shared),
      readOnly: acc ? acc.get(s.id) === "read" : undefined,
      title: m?.titleOverride ?? s.title,
      forkedFromSessionId: m?.forkedFromSessionId ?? undefined,
      forkedFromMessageId: m?.forkedFromMessageId ?? undefined,
      agentProfile: profileFrom(s.id, m) ?? undefined,
      parentSessionId: m?.parentSessionId ?? m?.forkedFromSessionId ?? s.parentSessionId ?? undefined,
      activeRun: r
        ? {
            runId: r.runId,
            status: r.status,
            pendingApproval: r.pendingApproval ? JSON.parse(r.pendingApproval) : undefined,
          }
        : undefined,
    };
  });
}

function touchMeta(user: CurrentUser, sessionId: string, patch: Partial<typeof schema.sessionMeta.$inferInsert> = {}) {
  const insert = db()
    .insert(schema.sessionMeta)
    .values({ sessionId, userId: user.id, ...patch });
  if (Object.keys(patch).length) insert.onConflictDoUpdate({ target: schema.sessionMeta.sessionId, set: { ...patch } }).run();
  else insert.onConflictDoNothing().run();
}

/** Refuse IDs that look malformed so arbitrary strings never reach upstream paths. */
export function assertSessionId(id: string) {
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(id)) throw new HttpError(400, "bad_session_id", "Invalid session id");
}

function assertRunOwner(user: CurrentUser, runId: string) {
  const run = db().select().from(schema.runs).where(eq(schema.runs.runId, runId)).get();
  if (!run || run.userId !== user.id) throw new HttpError(404, "run_not_found", "Run not found");
  return run;
}

export type SessionListOptions = { includeArchived?: boolean; offset?: number; signal?: AbortSignal };

/** One raw upstream window per request, never scan until an owned row appears. */
export async function listSessionPage(user: CurrentUser, opts: SessionListOptions = {}) {
  const offset = opts.offset ?? 0;
  // Keep the original window for old native clients; updated clients opt into 20.
  const limit = opts.offset === undefined ? 100 : 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new HttpError(400, "bad_offset", "Invalid conversation offset");
  }
  opts.signal?.throwIfAborted();
  const [res, routed] = await Promise.all([
    HermesSessionClient.list(connForProfile(null), { limit, offset, includeChildren: true, signal: opts.signal }),
    // Routed conversations page alongside the default list: page k of the default
    // window carries routed rows [k*N, (k+1)*N), so "load more" reaches all of them.
    opts.offset === undefined || offset % limit === 0
      ? routedSessions(user, { page: Math.floor(offset / limit), includeArchived: opts.includeArchived, signal: opts.signal })
      : Promise.resolve({ sessions: [], unavailable: [] as string[], hasMore: false }),
  ]);
  if ((res.offset !== undefined && res.offset !== offset) || (res.limit !== undefined && res.limit !== limit)) {
    throw new UpstreamError("Hermes", "bad_response", "Hermes returned a different conversation window");
  }
  // Pins can be back-filled beyond limit and upstream can under-report has_more
  // when a pin occupies the recency window. Err toward continuation, not loss.
  const hasMore = res.has_more === true || res.data.length >= limit || routed.hasMore;
  const visible = res.data.filter((s) => !s.hidden && s.source !== SYNC_SESSION_SOURCE);
  // Persist relationships encountered in an already-requested list page, never scan on chat open.
  for (const raw of [...visible, ...routed.sessions]) {
    const s = normalizeSession(raw);
    if (!isSubagentSession(s) || !s.parentSessionId || !sessionAccess(user, s.parentSessionId)) continue;
    upsertExecution(
      s.parentSessionId,
      {
        key: `subagent:${s.id}`,
        source: "subagent",
        id: s.id,
        childSessionId: s.id,
        title: s.title,
        state: "unknown",
        startedAt: s.startedAt,
        updatedAt: s.lastActiveAt,
      },
      sessionProfile(s.parentSessionId),
    );
  }
  // Sub-agent child sessions (Hermes delegate_task) fold under their parent row instead of flooding the list.
  const sessions = decorate(foldSubagents([...visible, ...routed.sessions].map(normalizeSession)), user).filter((s) => opts.includeArchived || !s.archived);
  return {
    sessions: [...new Map(sessions.map((s) => [s.id, s])).values()],
    unavailableProfiles: routed.unavailable,
    // Advance by the SQL window, not the filtered count or appended pin count.
    nextOffset: hasMore ? offset + limit : null,
  };
}

/**
 * Conversations Jarvis started on other Hermes profiles (Settings → Agents) live in
 * those profiles' stores, so the default list never returns them. Fetch the most
 * recent ones by id, one page per default-list page (no list scans). Ownership and
 * archive filters run in SQL so other users' or archived rows don't use up the page.
 */
async function routedSessions(user: CurrentUser, opts: { page: number; includeArchived?: boolean; signal?: AbortSignal }) {
  const signal = opts.signal;
  const rows = db()
    .select({
      sessionId: schema.sessionMeta.sessionId,
      profile: schema.sessionMeta.hermesProfile,
      userId: schema.sessionMeta.userId,
      shared: schema.sessionMeta.shared,
    })
    .from(schema.sessionMeta)
    .where(
      and(
        isNotNull(schema.sessionMeta.hermesProfile),
        or(eq(schema.sessionMeta.userId, user.id), eq(schema.sessionMeta.shared, true)),
        opts.includeArchived ? undefined : eq(schema.sessionMeta.archived, false),
      ),
    )
    .orderBy(desc(schema.sessionMeta.lastSeenAt), desc(schema.sessionMeta.createdAt), desc(schema.sessionMeta.sessionId))
    .limit(ROUTED_LIST_LIMIT + 1)
    .offset(opts.page * ROUTED_LIST_LIMIT)
    .all();
  const hasMore = rows.length > ROUTED_LIST_LIMIT;
  rows.length = Math.min(rows.length, ROUTED_LIST_LIMIT);
  // Up to 30 GETs + one list per profile: background lane, so this fan-out never takes the
  // connection slots a chat send needs (server/http/hermes-budget.ts).
  const [got, children] = await withHermesLane("background", () =>
    Promise.all([
      Promise.allSettled(
        rows.map(async (r) => {
          signal?.throwIfAborted();
          return (await HermesSessionClient.get(connForProfile(r.profile), r.sessionId)).session;
        }),
      ),
      // #187: sub-agent children of routed chats live on their own profile, never in the default
      // window, so fetch each listed profile's recent children once (cached) to count them.
      Promise.all([...new Set(rows.map((r) => r.profile!))].map((p) => routedChildren(p, signal))).then((x) => x.flat()),
    ]),
  );
  // A deleted session (404) is simply gone; any other failure means that profile is
  // unreachable, so the caller reports a retryable partial list instead of a complete one.
  const unavailable = [
    ...new Set(
      got.flatMap((g, i) => (g.status === "rejected" && !(g.reason instanceof UpstreamError && g.reason.kind === "not_found") ? [rows[i]!.profile!] : [])),
    ),
  ];
  const sessions = got.flatMap((g) => (g.status === "fulfilled" && !g.value.hidden ? [g.value] : []));
  const listed = new Set(sessions.map((s) => s.id));
  // Only children of listed parents; foldSubagents drops them from the list and counts them on the parent.
  return { sessions: [...sessions, ...children.filter((c) => c.parent_session_id && listed.has(c.parent_session_id))], unavailable, hasMore };
}
const ROUTED_LIST_LIMIT = 30;

type RawSession = Awaited<ReturnType<typeof HermesSessionClient.list>>["data"][number];
const CHILDREN_TTL_MS = 60_000;
const childrenCache = new Map<string, { at: number; rows: RawSession[] }>();

/** One recent-sessions list on a routed profile, keeping only sub-agent children (cached 60 s; failures count as none). */
async function routedChildren(profile: string, signal?: AbortSignal): Promise<RawSession[]> {
  const hit = childrenCache.get(profile);
  if (hit && Date.now() - hit.at < CHILDREN_TTL_MS) return hit.rows;
  try {
    const res = await HermesSessionClient.list(connForProfile(profile), { limit: 100, offset: 0, includeChildren: true, signal });
    const rows = res.data.filter((s) =>
      isSubagentSession({ parentSessionId: s.parent_session_id ?? undefined, source: s.source ?? undefined, title: s.title ?? "" }),
    );
    childrenCache.set(profile, { at: Date.now(), rows });
    return rows;
  } catch {
    return [];
  }
}

/** Test hook: forget cached routed-profile children. */
export function __resetRoutedChildrenCache() {
  childrenCache.clear();
}

// Existing non-chat callers retain their bounded legacy window.
export async function listSessions(user: CurrentUser, opts: { includeArchived?: boolean } = {}) {
  return (await listSessionPage(user, opts)).sessions;
}

// --- Adopt an existing session (one Jarvis didn't create) ---

/** The profile's peer-DM inbox. Never adopted: two clients on one session interleave turns and approvals. */
export const BOT_CHAT_TITLE = "Bot Chat";

type AdoptRow = Pick<SessionSummary, "id" | "title" | "lastActiveAt" | "messageCount" | "source" | "parentSessionId"> & { hidden?: boolean };

/** Why a session can't be adopted (null = it can). */
export function adoptRefusal(s: { title?: string | null; hidden?: boolean | null; source?: string | null; parentSessionId?: string | null }): string | null {
  if ((s.title ?? "").trim().toLowerCase() === BOT_CHAT_TITLE.toLowerCase()) return "bot_chat";
  if (s.hidden) return "hidden";
  if (s.source === SYNC_SESSION_SOURCE) return "system";
  if (s.parentSessionId && isSubagentSession({ parentSessionId: s.parentSessionId, source: s.source ?? undefined, title: s.title ?? "" })) return "subagent";
  return null;
}

const ADOPT_REFUSED: Record<string, string> = {
  bot_chat: "That's the agent's Bot Chat inbox — other agents message it. Start a new chat in the area instead.",
  hidden: "That conversation is hidden in Hermes, so it can't be filed here.",
  system: "That's a background sync conversation, not a chat.",
  subagent: "That's a sub-agent's working session. Open its parent conversation instead.",
};

/**
 * Recent sessions on a profile that Jarvis doesn't track yet (no session_meta row): the
 * profile's own chats from the Hermes web UI/CLI. Bot Chat, hidden, sync and sub-agent
 * sessions are left out. One Hermes list call on that profile, on explicit request only.
 */
export async function adoptableSessions(user: CurrentUser, profile: string | null, signal?: AbortSignal) {
  if (user.id !== getOwner()?.id) throw new HttpError(403, "forbidden", "Only the owner can adopt existing conversations");
  const conn = connForProfile(profile);
  const res = await HermesSessionClient.list(conn, { limit: 50, offset: 0, includeChildren: false, signal });
  const rows = res.data.map((s) => ({ ...normalizeSession(s), hidden: Boolean(s.hidden) }));
  const known = metaFor(rows.map((r) => r.id));
  const sessions: AdoptRow[] = rows
    .filter((r) => !known.has(r.id) && !adoptRefusal(r) && !r.archived)
    .slice(0, 30)
    .map((r) => ({ id: r.id, title: r.title, lastActiveAt: r.lastActiveAt, messageCount: r.messageCount, source: r.source }));
  return { profile: profile ?? null, sessions };
}

/**
 * Start tracking a Hermes session Jarvis didn't create, on the profile it lives on: one GET on
 * that profile, refuse Bot Chat/hidden/sub-agent sessions, then record session_meta (owner +
 * profile) so lists, opens and runs use the right profile. Filing into an area is a separate
 * call (the existing file route), made by the client right after.
 */
export async function adoptSession(user: CurrentUser, body: { profile: string | null; sessionId: string }, correlationId: string) {
  assertSessionId(body.sessionId);
  if (user.id !== getOwner()?.id) throw new HttpError(403, "forbidden", "Only the owner can adopt existing conversations");
  const profile = body.profile?.trim().toLowerCase() || null;
  const existing = metaFor([body.sessionId]).get(body.sessionId);
  if (existing && (existing.hermesProfile ?? null) !== profile)
    throw new HttpError(409, "profile_mismatch", "Jarvis already tracks that conversation on another agent.");
  let raw;
  try {
    raw = (await HermesSessionClient.get(connForProfile(profile), body.sessionId)).session;
  } catch (err) {
    if (err instanceof UpstreamError && err.kind === "not_found") throw new HttpError(404, "session_not_found", "That agent has no conversation with this id.");
    throw err;
  }
  const s = normalizeSession(raw);
  const why = adoptRefusal({ title: raw.title, hidden: Boolean(raw.hidden), source: raw.source, parentSessionId: raw.parent_session_id });
  if (why) {
    audit({
      actor: user.id,
      action: "hermes.session.adopt",
      source: "hermes",
      sourceRecord: body.sessionId,
      result: "rejected",
      correlationId,
      detail: { profile, reason: why },
    });
    throw new HttpError(409, `not_adoptable_${why}`, ADOPT_REFUSED[why]!);
  }
  touchMeta(user, body.sessionId, profile ? { hermesProfile: profile } : {});
  audit({ actor: user.id, action: "hermes.session.adopt", source: "hermes", sourceRecord: body.sessionId, result: "ok", correlationId, detail: { profile } });
  const [summary] = decorate([s], user);
  return { session: summary! };
}

/** Forks listed on a conversation page (each is one Hermes GET). */
const MAX_LINEAGE = 20;

export async function getSessionDetail(user: CurrentUser, id: string) {
  assertSessionId(id);
  assertAccess(user, id, "read");
  const conn = connForSession(id);
  const [session, messages] = await Promise.all([HermesSessionClient.get(conn, id), HermesSessionClient.messages(conn, id, { order: "latest", limit: 500 })]);
  const rawSummary = normalizeSession(session.session);
  // Unindexed default-profile children must obey parent permissions too, not the owner fallback.
  if (isSubagentSession(rawSummary)) assertAccess(user, rawSummary.parentSessionId!, "read");
  const [summary] = decorate([rawSummary], user);
  // Lineage without a session-list scan: Hermes' list is slow (it materialises every session before LIMIT,
  // ~9 s on prod), and it ran on every conversation open, so a new chat took ~10 s to appear. Jarvis records
  // every fork it makes in session_meta, so children come from there; the parent is one GET.
  const localChildren = db()
    .select()
    .from(schema.sessionMeta)
    .where(or(eq(schema.sessionMeta.forkedFromSessionId, id), eq(schema.sessionMeta.parentSessionId, id)))
    .limit(MAX_LINEAGE)
    .all()
    .filter((c) => sessionAccess(user, c.sessionId));
  const getSummary = (sid: string) =>
    HermesSessionClient.get(connForSession(sid), sid)
      .then((r) => normalizeSession(r.session))
      .catch(() => null);
  const parentId = summary!.parentSessionId && sessionAccess(user, summary!.parentSessionId) ? summary!.parentSessionId : undefined;
  const [childRows, parentRow] = await Promise.all([
    Promise.all(localChildren.map((c) => getSummary(c.sessionId))),
    parentId ? getSummary(parentId) : Promise.resolve(null),
  ]);
  const children = decorate(
    childRows.filter((c): c is SessionSummary => Boolean(c)),
    user,
  );
  const parent: SessionSummary | undefined = parentRow ? decorate([parentRow], user)[0] : undefined;
  return {
    session: summary!,
    timeline: messagesToTimeline(messages.data),
    parent,
    children,
  };
}

/** Access-checked summary of one session: a single GET, no messages or list scan. */
export async function getSessionSummary(user: CurrentUser, id: string) {
  assertSessionId(id);
  assertAccess(user, id, "read");
  const res = await HermesSessionClient.get(connForSession(id), id);
  const rawSummary = normalizeSession(res.session);
  if (isSubagentSession(rawSummary)) assertAccess(user, rawSummary.parentSessionId!, "read");
  const [summary] = decorate([rawSummary], user);
  if (!summary) throw new HttpError(404, "session_not_found", "Conversation not found");
  return summary;
}

/**
 * Hermes rejects a title another session already uses (400 invalid_title), so asking the same
 * question twice failed. Retry with a numbered title, then untitled (Hermes titles it later).
 */
async function createWithFreeTitle(conn: HermesConn, title: string | undefined) {
  const attempts = title ? [title, `${title} (2)`, `${title} (3)`, undefined] : [undefined];
  let last: unknown;
  for (const t of attempts) {
    try {
      return await HermesSessionClient.create(conn, { title: t, source: "api_server" });
    } catch (err) {
      if (!isTitleTaken(err)) throw err;
      last = err;
    }
  }
  throw last;
}

export const isTitleTaken = (err: unknown) => err instanceof UpstreamError && /invalid_title|already in use/i.test(err.message);

/** `profile`: a routed Hermes profile (server/agents/routing.ts resolveAgent), null/undefined = default. */
export async function createSession(user: CurrentUser, title?: string, profile?: string | null) {
  const conn = connForProfile(profile ?? null);
  const res = await createWithFreeTitle(conn, title?.trim() || undefined);
  touchMeta(user, res.session.id, profile ? { hermesProfile: profile } : {});
  return decorate([normalizeSession(res.session)], user)[0]!;
}

export async function updateSession(
  user: CurrentUser,
  id: string,
  patch: { title?: string | null; archived?: boolean; pinned?: boolean; shared?: boolean },
  correlationId: string,
) {
  assertSessionId(id);
  assertAccess(user, id, "write");
  const { shared, ...upstream } = patch;
  const conn = connForSession(id);
  const res = Object.keys(upstream).length ? await HermesSessionClient.update(conn, id, upstream) : await HermesSessionClient.get(conn, id);
  touchMeta(user, id, {
    ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    ...(shared !== undefined ? { shared } : {}),
  });
  audit({ actor: user.id, action: "hermes.session.update", source: "hermes", sourceRecord: id, result: "ok", correlationId, detail: patch });
  return decorate([normalizeSession(res.session)], user)[0]!;
}

export type ForkInput = {
  title?: string;
  /** fork at an earlier message instead of the latest state */
  fromMessageId?: string;
  prompt?: string;
  idempotencyKey?: string;
};

/**
 * Fork a conversation.
 *  - Latest state: Hermes' native POST /api/sessions/:id/fork (copies the full
 *    transcript into a child; Hermes marks the source end_reason=branched but
 *    leaves its messages untouched).
 *  - From a specific message: the pinned Hermes version has no HTTP fork-point,
 *    so a text-only restart seeds conversation_history up to that message.
 *    Refuse unverified/truncated windows and unsupported context before writes.
 *    This does not copy the parent's model/system configuration. Lineage is local.
 */
export async function forkSession(user: CurrentUser, id: string, input: ForkInput, correlationId: string) {
  assertSessionId(id);
  assertAccess(user, id, "read");
  const profile = sessionProfile(id);
  const conn = connForProfile(profile);
  const lineage = profile ? { hermesProfile: profile } : {};
  let child: SessionSummary;
  let run: RunView | undefined;
  if (!input.fromMessageId) {
    const res = await HermesSessionClient.fork(conn, id, { title: input.title?.trim() || undefined });
    child = normalizeSession(res.session);
    touchMeta(user, child.id, { forkedFromSessionId: id, ...lineage });
  } else {
    if (!input.prompt?.trim()) {
      throw new HttpError(400, "prompt_required", "Forking from an earlier message needs a first prompt.");
    }
    // The HTTP API has no fork-point operation. Only seed a verified complete,
    // bounded text transcript; never silently drop an older window or tool context.
    const messages = await HermesSessionClient.messages(conn, id, { order: "oldest", limit: 500, offset: 0, includeCompacted: true });
    const pagination = messages.pagination;
    if (
      !pagination ||
      pagination.order !== "oldest" ||
      pagination.offset !== 0 ||
      pagination.limit !== 500 ||
      pagination.returned !== messages.data.length ||
      messages.data.length >= 500 ||
      pagination.has_more === true ||
      new Set(messages.data.map((m) => String(m.id))).size !== messages.data.length
    ) {
      throw new HttpError(409, "fork_history_incomplete", "Cannot verify a complete transcript below the 500-message limit. Use Fork latest state instead.");
    }
    const idx = messages.data.findIndex((m) => String(m.id) === input.fromMessageId);
    if (idx === -1) throw new HttpError(404, "message_not_found", "That message is no longer in the conversation");
    const history = messages.data.slice(0, idx + 1).map((m) => {
      if (
        (m.role !== "user" && m.role !== "assistant") ||
        typeof m.content !== "string" ||
        m.tool_calls?.length ||
        m.tool_call_id ||
        m.tool_name ||
        m.reasoning ||
        m.reasoning_content ||
        m.display_kind ||
        (m.finish_reason && m.finish_reason !== "stop")
      ) {
        throw new HttpError(
          409,
          "fork_context_unsupported",
          "Text-only restart cannot preserve this tool, reasoning, or non-text context. Use Fork latest state instead.",
        );
      }
      return { role: m.role, content: m.content };
    });
    const parent = await HermesSessionClient.get(conn, id);
    const created = await HermesSessionClient.create(conn, {
      title: input.title?.trim() || `${parent.session.title ?? "Conversation"} (fork)`,
      source: "api_server",
    });
    child = normalizeSession(created.session);
    touchMeta(user, child.id, { forkedFromSessionId: id, forkedFromMessageId: input.fromMessageId, ...lineage });
    run = await startRun(
      user,
      {
        sessionId: child.id,
        input: input.prompt,
        idempotencyKey: input.idempotencyKey ?? `fork-${id}-${input.fromMessageId}-${Date.now()}`,
        conversationHistory: history,
      },
      correlationId,
    );
  }
  audit({
    actor: user.id,
    action: "hermes.session.fork",
    source: "hermes",
    sourceRecord: id,
    result: "ok",
    correlationId,
    detail: { child: child.id, fromMessageId: input.fromMessageId },
  });
  if (input.prompt?.trim() && !run) {
    run = await startRun(user, { sessionId: child.id, input: input.prompt, idempotencyKey: input.idempotencyKey ?? `fork-${child.id}` }, correlationId);
  }
  return { session: decorate([child], user)[0]!, run };
}

export type StartRunRequest = {
  sessionId: string;
  input: string;
  /** image URLs (data:/https) for Hermes `image_url` parts; Claude-direct ignores them */
  images?: string[];
  idempotencyKey: string;
  model?: string;
  provider?: string;
  /** Hermes `model_options`, e.g. the chat default's reasoning effort */
  modelOptions?: Record<string, unknown>;
  /** per-area agent mode / instructions (Areas); Hermes-only, Claude-direct ignores it */
  instructions?: string;
  conversationHistory?: { role: string; content: string }[];
};

export async function startRun(user: CurrentUser, r: StartRunRequest, correlationId: string): Promise<RunView> {
  assertSessionId(r.sessionId);
  assertAccess(user, r.sessionId, "write");
  if (!/^[\x21-\x7e]{1,255}$/.test(r.idempotencyKey)) throw new HttpError(400, "bad_idempotency_key", "Invalid idempotency key");
  const existing = db().select().from(schema.runs).where(eq(schema.runs.idempotencyKey, r.idempotencyKey)).get();
  if (existing) {
    if (existing.userId !== user.id || existing.sessionId !== r.sessionId) {
      throw new HttpError(409, "idempotency_conflict", "Idempotency key belongs to another request");
    }
    return { runId: existing.runId, sessionId: existing.sessionId, status: existing.status as RunView["status"] };
  }
  const profile = sessionProfile(r.sessionId);
  const res = await HermesExecutionClient.start(connForProfile(profile), r);
  const status = res.status === "queued" ? "queued" : "running";
  db()
    .insert(schema.runs)
    .values({
      runId: res.run_id,
      sessionId: r.sessionId,
      userId: user.id,
      hermesProfile: profile,
      idempotencyKey: r.idempotencyKey,
      status,
      inputPreview: r.input.slice(0, 140),
    })
    .onConflictDoNothing()
    .run();
  touchMeta(user, r.sessionId, { lastSeenAt: new Date().toISOString() });
  audit({
    actor: user.id,
    action: "hermes.run.start",
    source: "hermes",
    sourceRecord: r.sessionId,
    result: "ok",
    correlationId,
    detail: { runId: res.run_id },
  });
  return { runId: res.run_id, sessionId: r.sessionId, status };
}

function updateRunRow(runId: string, patch: Partial<typeof schema.runs.$inferInsert>) {
  db()
    .update(schema.runs)
    .set({ ...patch, lastCheckedAt: new Date().toISOString() })
    .where(eq(schema.runs.runId, runId))
    .run();
}

/** Authoritative state from Hermes. Never infer completion from a closed stream. */
export async function reconcileRun(runId: string): Promise<RunView> {
  const row = db().select().from(schema.runs).where(eq(schema.runs.runId, runId)).get();
  try {
    const s = await HermesExecutionClient.status(connForRun(row), runId);
    const approval = s.status === "waiting_for_approval" ? normalizeApproval(s.approval ?? firstApprovalPrompt(s)) : undefined;
    const terminal = isTerminal(s.status);
    updateRunRow(runId, {
      status: s.status,
      pendingApproval: approval ? JSON.stringify(approval) : null,
      ...(terminal && !row?.completedAt ? { completedAt: new Date().toISOString() } : {}),
    });
    return {
      runId,
      sessionId: s.session_id ?? row?.sessionId ?? "",
      status: s.status as RunView["status"],
      output: s.output ?? undefined,
      error: s.error ?? undefined,
      pendingSteer: s.pending_steer ?? undefined,
      pendingApproval: approval,
      pendingClarify: terminal ? undefined : normalizeClarify(pendingClarifyPrompt(s)),
    };
  } catch (err) {
    if (err instanceof UpstreamError && err.kind === "not_found" && row) {
      // Hermes forgets terminal runs after ~1h (24h with idempotency). If we never
      // saw a terminal state, report it as interrupted rather than completed.
      const status = isTerminal(row.status) ? row.status : "interrupted";
      updateRunRow(runId, { status, completedAt: row.completedAt ?? new Date().toISOString() });
      return { runId, sessionId: row.sessionId, status: status as RunView["status"] };
    }
    throw err;
  }
}

export async function getRun(user: CurrentUser, runId: string) {
  assertRunOwner(user, runId);
  return reconcileRun(runId);
}

export async function stopRun(user: CurrentUser, runId: string, correlationId: string): Promise<RunView> {
  const row = assertRunOwner(user, runId);
  const res = await HermesExecutionClient.stop(connForRun(row), runId);
  // Remain "stopping" until Hermes confirms a terminal state.
  const status = isTerminal(res.status) ? res.status : "stopping";
  updateRunRow(runId, { status });
  audit({ actor: user.id, action: "hermes.run.stop", source: "hermes", sourceRecord: runId, result: "ok", correlationId });
  return { runId, sessionId: row.sessionId, status: status as RunView["status"] };
}

const firstApprovalPrompt = (s: Pick<HermesRunStatus, "pending_controls">) => (s.pending_controls ?? []).find((p) => p.kind === "approval");

/** The approval prompt a session-authority run is waiting on (`GET /v1/runs/{id}` → `pending_controls`). */
export function pendingApprovalPrompt(s: Pick<HermesRunStatus, "pending_controls">, requestId?: string) {
  const prompts = (s.pending_controls ?? []).filter((p) => p.kind === "approval" && typeof p.prompt_id === "string");
  // A known id answers exactly that prompt, never another one that replaced it. A card without an
  // id (built before Jarvis read `prompt_id`) may only answer when exactly one prompt is waiting.
  if (requestId) return prompts.find((p) => p.prompt_id === requestId);
  return prompts.length === 1 ? prompts[0] : undefined;
}

/**
 * The exact `/v1/runs/{id}/approval` body for this Hermes. A session-authority run (status carries
 * `execution_generation`) only accepts `{ choice, request_id, execution_generation }` — any other key
 * set is 400 `invalid_params` — and `request_id` must be a pending prompt's `prompt_id`. The legacy run
 * store takes `{ choice, request_id? }`. Returns null when an authority run has no matching prompt.
 */
export function approvalBody(
  s: Pick<HermesRunStatus, "execution_generation" | "pending_controls">,
  choice: ApprovalChoice,
  requestId?: string,
): HermesApprovalBody | null {
  if (typeof s.execution_generation !== "number") return requestId ? { choice, request_id: requestId } : { choice };
  const prompt = pendingApprovalPrompt(s, requestId);
  if (!prompt) return null;
  const generation = typeof prompt.execution_generation === "number" ? prompt.execution_generation : s.execution_generation;
  return { choice, request_id: prompt.prompt_id as string, execution_generation: generation };
}

type ApprovalChoice = "once" | "session" | "always" | "deny";

/** The clarify prompt a session-authority run is waiting on (`pending_controls` kind `clarify`). */
export function pendingClarifyPrompt(s: Pick<HermesRunStatus, "pending_controls">, requestId?: string) {
  const prompts = (s.pending_controls ?? []).filter((p) => p.kind === "clarify" && typeof p.prompt_id === "string");
  if (requestId) return prompts.find((p) => p.prompt_id === requestId);
  return prompts.length === 1 ? prompts[0] : undefined;
}

/** Hermes caps a clarify answer at 16384 characters (session_pending_controls.py). */
export const CLARIFY_ANSWER_MAX = 16384;

/**
 * The exact `/v1/runs/{id}/clarify` body: `{ answer, request_id, execution_generation }` — any other
 * key set is 400 `invalid_params`. Only the session-authority path has clarify; returns null when the
 * run carries no generation or no matching pending clarify prompt.
 */
export function clarifyBody(
  s: Pick<HermesRunStatus, "execution_generation" | "pending_controls">,
  answer: string,
  requestId: string,
): HermesClarifyBody | null {
  if (typeof s.execution_generation !== "number") return null;
  if (typeof answer !== "string" || !answer.trim() || answer.length > CLARIFY_ANSWER_MAX) return null;
  const prompt = pendingClarifyPrompt(s, requestId);
  if (!prompt) return null;
  const generation = typeof prompt.execution_generation === "number" ? prompt.execution_generation : s.execution_generation;
  return { answer, request_id: prompt.prompt_id as string, execution_generation: generation };
}

const CLARIFY_GONE = "This question isn't waiting any more — it was answered, timed out or the run moved on.";

export async function respondClarify(user: CurrentUser, runId: string, body: { answer: string; requestId: string }, correlationId: string) {
  const row = assertRunOwner(user, runId);
  const conn = connForRun(row);
  // Audit the fact of answering, never the answer text (it can be anything the person typed).
  const detail = { requestId: body.requestId, chars: body.answer.length };
  try {
    const status = await HermesExecutionClient.status(conn, runId);
    const upstreamBody = clarifyBody(status, body.answer, body.requestId);
    if (!upstreamBody) throw new HttpError(409, "clarify_not_pending", CLARIFY_GONE);
    let res;
    try {
      res = await HermesExecutionClient.clarify(conn, runId, upstreamBody);
    } catch (err) {
      if (err instanceof UpstreamError && err.kind === "conflict") throw new HttpError(409, "clarify_not_pending", CLARIFY_GONE);
      throw err;
    }
    audit({ actor: user.id, action: "hermes.clarify", source: "hermes", sourceRecord: runId, result: "ok", correlationId, detail });
    return res;
  } catch (err) {
    audit({
      actor: user.id,
      action: "hermes.clarify",
      source: "hermes",
      sourceRecord: runId,
      result: "error",
      correlationId,
      detail: { ...detail, error: (err as Error).message },
    });
    throw err;
  }
}

export async function respondApproval(user: CurrentUser, runId: string, body: { choice: ApprovalChoice; requestId?: string }, correlationId: string) {
  const row = assertRunOwner(user, runId);
  const conn = connForRun(row);
  try {
    // Read the live run first: the request shape depends on the Hermes run path, and the
    // authority path needs the current generation + prompt id (an old card may carry neither).
    const status = await HermesExecutionClient.status(conn, runId);
    const upstreamBody = approvalBody(status, body.choice, body.requestId);
    if (!upstreamBody) {
      updateRunRow(runId, { pendingApproval: null });
      throw new HttpError(409, "approval_not_pending", "This approval isn't waiting any more — it was answered, expired or the run moved on.");
    }
    let res;
    try {
      res = await HermesExecutionClient.approve(conn, runId, upstreamBody);
    } catch (err) {
      if (err instanceof UpstreamError && err.kind === "conflict")
        throw new HttpError(409, "approval_not_pending", "This approval isn't waiting any more — it was answered, expired or the run moved on.");
      throw err;
    }
    updateRunRow(runId, { pendingApproval: null, status: "running" });
    audit({ actor: user.id, action: "hermes.approval", source: "hermes", sourceRecord: runId, result: "ok", correlationId, detail: body });
    return res;
  } catch (err) {
    audit({
      actor: user.id,
      action: "hermes.approval",
      source: "hermes",
      sourceRecord: runId,
      result: "error",
      correlationId,
      detail: { ...body, error: (err as Error).message },
    });
    throw err;
  }
}

export async function steerRun(user: CurrentUser, runId: string, input: string, correlationId: string) {
  const row = assertRunOwner(user, runId);
  const res = await HermesExecutionClient.steer(connForRun(row), runId, input);
  audit({ actor: user.id, action: "hermes.steer", source: "hermes", sourceRecord: runId, result: "ok", correlationId });
  return res;
}

// --- SSE relay ---

type RelayEvent = { e: RunEvent; id?: number };
type RelaySub = { push: (ev: RelayEvent) => void; end: () => void };
/** One upstream event stream per run, shared by every tab/pane watching it (chat page, rail, tray, other devices). */
type SharedRelay = {
  runId: string;
  /** Last-Event-ID the upstream was opened with (undefined = from the start). */
  fromSeq: number | undefined;
  buffer: RelayEvent[];
  /** Buffer overflowed: late joiners can't be replayed from it, so they open their own relay. */
  truncated: boolean;
  subs: Set<RelaySub>;
  /** Waiting for a connection-budget slot. */
  waiting: boolean;
  done: boolean;
  abort: AbortController;
};
const RELAY_BUFFER_MAX = 20_000;
const RELAY_MAX_RELAYS = 64;
const relays = () => processSingleton("hermes_shared_relays", () => ({ byRun: new Map<string, SharedRelay>(), all: new Set<SharedRelay>() }));

/** Test hook: open upstream relays and how many browser streams each serves. */
export function __relayStats() {
  return [...relays().all].map((r) => ({ runId: r.runId, subscribers: r.subs.size, waiting: r.waiting, done: r.done }));
}

function canJoin(r: SharedRelay, lastSeq: number | undefined) {
  if (r.done || r.truncated) return false;
  return r.fromSeq === undefined || (lastSeq !== undefined && lastSeq >= r.fromSeq);
}

/** Events a joiner that already saw up to `lastSeq` still needs. */
function replayFrom(r: SharedRelay, lastSeq: number | undefined) {
  if (lastSeq === undefined) return r.buffer;
  const i = r.buffer.findIndex((b) => b.id !== undefined && b.id > lastSeq);
  return i < 0 ? [] : r.buffer.slice(i);
}

function startRelay(row: typeof schema.runs.$inferSelect, runId: string, lastSeq: number | undefined): SharedRelay {
  const r: SharedRelay = {
    runId,
    fromSeq: lastSeq,
    buffer: [],
    truncated: false,
    subs: new Set(),
    waiting: false,
    done: false,
    abort: new AbortController(),
  };
  const { byRun, all } = relays();
  all.add(r);
  if (!byRun.get(runId) || byRun.get(runId)!.done) byRun.set(runId, r);
  const broadcast = (ev: RelayEvent, keep = true) => {
    if (keep) {
      if (r.buffer.length < RELAY_BUFFER_MAX) r.buffer.push(ev);
      else r.truncated = true;
    }
    for (const s of [...r.subs]) s.push(ev);
  };
  void (async () => {
    let slot: Slot | undefined;
    let sawTerminal = false;
    try {
      // Every relay holds an upstream connection for the whole run: wait for a budget slot
      // instead of failing, and tell the watchers they're queued.
      slot = await acquireHermesSlot("stream", {
        signal: r.abort.signal,
        onQueued: () => {
          r.waiting = true;
          broadcast({ e: { type: "run.queued", reason: "connections" } }, false);
        },
      });
      r.waiting = false;
      const res = await HermesExecutionClient.events(connForRun(row), runId, lastSeq !== undefined ? String(lastSeq) : undefined, r.abort.signal);
      if (!res.body) throw new UpstreamError("Hermes", "bad_response", "Hermes returned an empty event stream");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new SseParser();
      for (;;) {
        const { value, done } = await reader.read();
        const frames = done ? parser.end() : parser.push(value);
        for (const f of frames) {
          let raw: unknown;
          try {
            raw = JSON.parse(f.data);
          } catch {
            continue;
          }
          const parsed = runEventSchema.safeParse(raw);
          if (!parsed.success) continue;
          const ev = normalizeRunEvent(parsed.data as never);
          if (ev.type === "subagent.started" || ev.type === "subagent.completed") {
            const id = ev.id ?? ev.childSessionId ?? (ev.delegationId && ev.taskIndex !== undefined ? `${ev.delegationId}:${ev.taskIndex}` : undefined);
            if (id) {
              const parentSessionId = executionParent(row.sessionId, ev.parentId);
              const state = ev.type === "subagent.started" ? "running" : executionCompletionState(ev.status);
              upsertExecution(
                parentSessionId,
                {
                  key: `subagent:${id}`,
                  source: "subagent",
                  id,
                  subagentId: ev.id,
                  observedCompletion: ev.type === "subagent.completed",
                  childSessionId: ev.childSessionId,
                  delegationId: ev.delegationId,
                  taskIndex: ev.taskIndex,
                  title: ev.goal ?? "Subagent",
                  state,
                  startedAt: ev.type === "subagent.started" ? ev.at : undefined,
                  endedAt: ["completed", "failed", "cancelled"].includes(state) ? ev.at : undefined,
                  updatedAt: ev.at,
                  summary: ev.type === "subagent.completed" ? ev.summary : undefined,
                },
                sessionProfile(parentSessionId),
              );
            }
          }
          if (ev.type === "approval.requested") {
            updateRunRow(runId, {
              status: "waiting_for_approval",
              pendingApproval: JSON.stringify({ requestId: ev.requestId, command: ev.command, description: ev.description, choices: ev.choices }),
            });
          } else if (ev.type === "approval.resolved") {
            updateRunRow(runId, { status: "running", pendingApproval: null });
          } else if (ev.type === "run.terminal") {
            sawTerminal = true;
            // Someone watched it finish live, so no "background work completed" alert is needed.
            updateRunRow(runId, {
              status: ev.status,
              pendingApproval: null,
              completedAt: new Date().toISOString(),
              notifiedCompletion: r.subs.size > 0,
            });
          }
          broadcast({ e: ev, id: parsed.data.seq ?? (f.id !== undefined ? Number(f.id) : undefined) });
        }
        if (done) break;
      }
      if (!sawTerminal) broadcast({ e: { type: "stream.closed", reason: "upstream_closed" } });
    } catch (err) {
      if (!r.abort.signal.aborted) broadcast({ e: { type: "stream.closed", reason: "error", message: (err as Error).message } });
    } finally {
      slot?.release();
      r.done = true;
      all.delete(r);
      if (byRun.get(runId) === r) byRun.delete(runId);
      for (const s of [...r.subs]) s.end();
      r.subs.clear();
    }
  })();
  return r;
}

/**
 * Relay /v1/runs/:id/events through the BFF as normalized Jarvis events.
 * The upstream key never reaches the browser. When the upstream stream ends
 * without a terminal event we emit `stream.closed` so the client reconciles.
 *
 * Connection budget: every browser stream watching the same run shares ONE upstream
 * stream (late joiners are replayed from its buffer), relays wait for a `stream` slot in
 * the Hermes budget (`run.queued` reason "connections" meanwhile) instead of failing,
 * and the upstream closes as soon as its last watcher leaves.
 */
export function relayRunEvents(
  user: CurrentUser,
  runId: string,
  lastSeq: string | undefined,
  clientSignal: AbortSignal,
  opts: { format?: "jarvis" | "agui" } = {},
) {
  const row = assertRunOwner(user, runId);
  // AG-UI (Coordinators C1, Settings → Agents flag): same relay, events translated by server/agui/hermes.ts.
  const agui =
    opts.format === "agui"
      ? new HermesAguiTranslator({ threadId: row.sessionId, hermesRunId: runId, resumeFromSeq: lastSeq !== undefined ? Number(lastSeq) : undefined })
      : null;
  const seq = lastSeq !== undefined ? Number(lastSeq) : undefined;
  const existing = relays().byRun.get(runId);
  const shared = existing && canJoin(existing, seq) ? existing : undefined;
  if (!shared && relays().all.size >= Math.max(config.maxStreams, RELAY_MAX_RELAYS)) {
    throw new HttpError(429, "too_many_streams", "Too many open streams");
  }
  const encoder = new TextEncoder();
  let finishRef = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // Filled in below; `finish` can run before that (the browser left during the first write).
      const link: { relay?: SharedRelay; sub?: RelaySub; keepalive?: ReturnType<typeof setInterval> } = {};
      const finish = () => {
        if (closed) return;
        closed = true;
        if (link.keepalive) clearInterval(link.keepalive);
        clientSignal.removeEventListener("abort", finish);
        const { relay, sub } = link;
        if (relay && sub) {
          relay.subs.delete(sub);
          // Last watcher gone: free the upstream connection now.
          if (relay.subs.size === 0 && !relay.done) relay.abort.abort();
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const write = (chunk: string) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          // The browser is gone: stop relaying and free the slot even if the abort signal never fires.
          finish();
          return false;
        }
      };
      const send = ({ e, id }: RelayEvent) => {
        if (!agui) return write(formatSse(e, id !== undefined ? { id } : {}));
        for (const a of agui.push(e)) if (!write(formatSse(a, id !== undefined ? { id } : {}))) return false;
        return true;
      };
      finishRef = finish;
      if (!write(": relay open\n\nretry: 2000\n\n") || clientSignal.aborted) return finish();
      link.keepalive = setInterval(() => write(": keepalive\n\n"), 15_000);
      clientSignal.addEventListener("abort", finish);
      const sub: RelaySub = { push: (ev) => void send(ev), end: finish };
      const r = shared ?? startRelay(row, runId, seq);
      link.relay = r;
      link.sub = sub;
      if (r.done) return finish();
      // Subscribe first (finish() then unsubscribes and frees the upstream if a write fails below).
      r.subs.add(sub);
      for (const ev of shared ? replayFrom(shared, seq) : []) if (!send(ev)) return;
      if (r.waiting) send({ e: { type: "run.queued", reason: "connections" } });
    },
    cancel() {
      finishRef();
    },
  });
}

/** Runs that still need reconciliation (used by the background worker). */
export function unfinishedRuns() {
  return db()
    .select()
    .from(schema.runs)
    .where(notInArray(schema.runs.status, [...RUN_TERMINAL]))
    .all();
}

export function runsNeedingCompletionNotice() {
  return db()
    .select()
    .from(schema.runs)
    .where(and(inArray(schema.runs.status, [...RUN_TERMINAL]), eq(schema.runs.notifiedCompletion, false)))
    .all();
}

export function markCompletionNotified(runId: string) {
  updateRunRow(runId, { notifiedCompletion: true });
}
