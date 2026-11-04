import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { newId, randomToken, sha256 } from "@/server/crypto";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { getOwner, userById, type CurrentUser } from "@/server/auth";
import { AGENT_TOKEN_PREFIX, parseScopes, type AgentScope, type AgentTokenView, type MintedAgentToken } from "@/lib/agent-access";

/**
 * Scoped agent tokens (docs/agent-tools.md). Only sha256(token) is stored; the token is returned
 * once at mint. A token is valid only on /api/mcp (resolveUser never accepts it), acts for the
 * owner who minted it, and carries a capability set built from its scopes — never finance.*,
 * never admin. Revoking is the kill switch: the next call is refused.
 */

type Row = typeof schema.agentTokens.$inferSelect;

const view = (r: Row): AgentTokenView => ({
  id: r.id,
  name: r.name,
  profile: r.profile,
  scopes: parseScopes(r.scopes),
  hint: r.hint,
  createdAt: r.createdAt,
  lastUsedAt: r.lastUsedAt,
  revokedAt: r.revokedAt,
});

const MAX_ACTIVE = 20;

export function listAgentTokens(userId: string): AgentTokenView[] {
  return getDb().select().from(schema.agentTokens).where(eq(schema.agentTokens.userId, userId)).orderBy(desc(schema.agentTokens.createdAt)).all().map(view);
}

export function mintAgentToken(user: CurrentUser, body: { name: string; profile: string; scopes: AgentScope[] }, correlationId: string): MintedAgentToken {
  if (user.id !== getOwner()?.id) throw new HttpError(403, "forbidden", "Only the owner can give agents access");
  const db = getDb();
  const active = db
    .select({ id: schema.agentTokens.id })
    .from(schema.agentTokens)
    .where(and(eq(schema.agentTokens.userId, user.id), isNull(schema.agentTokens.revokedAt)))
    .all().length;
  if (active >= MAX_ACTIVE) throw new HttpError(409, "too_many", "Revoke an unused agent token first");
  const token = `${AGENT_TOKEN_PREFIX}${randomToken(32)}`;
  const id = newId("agt");
  const scopes = [...new Set(body.scopes)];
  db.insert(schema.agentTokens)
    .values({ id, tokenHash: sha256(token), hint: token.slice(-4), name: body.name, profile: body.profile, scopes: JSON.stringify(scopes), userId: user.id })
    .run();
  audit({
    actor: user.id,
    action: "agent_token.mint",
    source: "agents",
    sourceRecord: id,
    result: "ok",
    correlationId,
    detail: { profile: body.profile, scopes },
  });
  return { token, view: view(db.select().from(schema.agentTokens).where(eq(schema.agentTokens.id, id)).get()!) };
}

export function revokeAgentToken(user: CurrentUser, id: string, correlationId: string): AgentTokenView {
  const db = getDb();
  const row = db
    .select()
    .from(schema.agentTokens)
    .where(and(eq(schema.agentTokens.id, id), eq(schema.agentTokens.userId, user.id)))
    .get();
  if (!row) throw new HttpError(404, "not_found", "That token isn't here");
  if (!row.revokedAt) db.update(schema.agentTokens).set({ revokedAt: new Date().toISOString() }).where(eq(schema.agentTokens.id, id)).run();
  audit({ actor: user.id, action: "agent_token.revoke", source: "agents", sourceRecord: id, result: "ok", correlationId, detail: { profile: row.profile } });
  return view(db.select().from(schema.agentTokens).where(eq(schema.agentTokens.id, id)).get()!);
}

/** Capabilities a scope set maps to (intersected with the owner's own). Never finance.*, never admin. */
export function capabilitiesForScopes(scopes: AgentScope[], ownerCaps: Set<string>): Set<string> {
  const want = new Set<string>();
  if (scopes.length) want.add("work.use");
  if (scopes.includes("conversations.file")) want.add("hermes.chat");
  return new Set([...want].filter((c) => ownerCaps.has(c) && !c.startsWith("finance") && c !== "admin"));
}

export type AgentPrincipal = {
  tokenId: string;
  profile: string;
  scopes: AgentScope[];
  /** the owner, with capabilities narrowed to the token's scopes */
  user: CurrentUser;
  /** "agent:<profile>" (work_events.via, Activity chips) */
  via: string;
};

const TOUCH_MS = 60_000;

/** Resolve a bearer token to an agent principal, or null (unknown, revoked, not the owner any more). */
export function agentFromToken(token: string | undefined | null, now = new Date()): AgentPrincipal | null {
  if (!token || !token.startsWith(AGENT_TOKEN_PREFIX) || token.length > 200) return null;
  const db = getDb();
  const row = db
    .select()
    .from(schema.agentTokens)
    .where(and(eq(schema.agentTokens.tokenHash, sha256(token)), isNull(schema.agentTokens.revokedAt)))
    .get();
  if (!row) return null;
  // Tokens act for the owner only; if ownership moved or the account is disabled, they stop working.
  if (row.userId !== getOwner()?.id) return null;
  const owner = userById(row.userId);
  if (!owner) return null;
  const scopes = parseScopes(row.scopes);
  if (!row.lastUsedAt || now.getTime() - Date.parse(row.lastUsedAt) > TOUCH_MS)
    db.update(schema.agentTokens).set({ lastUsedAt: now.toISOString() }).where(eq(schema.agentTokens.id, row.id)).run();
  return {
    tokenId: row.id,
    profile: row.profile,
    scopes,
    via: `agent:${row.profile}`,
    user: { ...owner, capabilities: capabilitiesForScopes(scopes, owner.capabilities) },
  };
}

/** Per-token rate limit (in memory; one Jarvis process): calls per minute. */
export const AGENT_RATE_PER_MIN = 120;
const hits = new Map<string, number[]>();

export function rateLimited(tokenId: string, now = Date.now(), limit = AGENT_RATE_PER_MIN): boolean {
  const recent = (hits.get(tokenId) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= limit) {
    hits.set(tokenId, recent);
    return true;
  }
  recent.push(now);
  hits.set(tokenId, recent);
  return false;
}

/** Tests only. */
export function __resetAgentRate() {
  hits.clear();
}
