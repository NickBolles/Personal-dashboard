import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/server/db";
import { getSetting, setSetting } from "@/server/settings";
import { UpstreamError } from "@/server/http/errors";
import { hermesConn, type HermesConn } from "@/integrations/hermes/client";
import { DEFAULT_AGENT_SETTINGS, agentSettingsSchema, PROFILE_NAME_RE, type AgentResolution, type AgentRoute, type AgentSettings } from "@/lib/agents";

/**
 * Per-area Hermes profile routing (Coordinators C1).
 *
 * Hermes multiplexes named profiles on one API server under `/p/<profile>/`,
 * each with its own profile-scoped API_SERVER_KEY. A route here names the env
 * var holding that key (Jarvis secrets env file); the key itself is never stored
 * in the database or sent to the browser.
 */

const KEY = "agents";

export function getAgentSettings(): AgentSettings {
  const raw = getSetting<unknown>(KEY);
  const parsed = agentSettingsSchema.safeParse({ ...DEFAULT_AGENT_SETTINGS, ...(raw && typeof raw === "object" ? raw : {}) });
  return parsed.success ? parsed.data : { ...DEFAULT_AGENT_SETTINGS };
}

export function saveAgentSettings(patch: Partial<AgentSettings>): AgentSettings {
  const next = agentSettingsSchema.parse({ ...getAgentSettings(), ...patch });
  setSetting(KEY, next);
  return next;
}

/** The route's own key, or (no `keyEnv`) the main Hermes connection key. */
const keyFor = (r: AgentRoute, main?: string) => {
  if (!r.keyEnv) {
    // The main key only goes to the main Hermes server, never to a route's custom host.
    if (r.baseUrl && originOf(r.baseUrl) !== originOf(safeDefaultBase())) return undefined;
    return main ?? mainKey();
  }
  const v = process.env[r.keyEnv];
  return v && v.trim().length >= 16 ? v.trim() : undefined;
};

function originOf(u: string | null) {
  try {
    return u ? new URL(u).origin : null;
  } catch {
    return null;
  }
}

function mainKey() {
  try {
    return hermesConn("admin-connection-test").apiKey || undefined;
  } catch {
    return undefined;
  }
}

/** True when the profile's key is present (never returns the key). */
export const routeKeyPresent = (r: AgentRoute) => Boolean(keyFor(r));

function routeFor(profile: string, s = getAgentSettings()) {
  return s.routes.find((r) => r.profile === profile);
}

/** `"default"` (or empty) means Hermes' default profile. */
const normalize = (p: string | null | undefined) => {
  const v = p?.trim().toLowerCase();
  return v && v !== "default" ? v : null;
};

/** Resolve who answers for a requested agent mode. Never throws. */
export function resolveAgent(requested: string | null | undefined, from: AgentResolution["from"] = null): AgentResolution {
  const want = normalize(requested);
  if (!want) return { requested: requested?.trim() || null, profile: null, routed: false, reason: "default", from };
  const s = getAgentSettings();
  if (!s.routing) return { requested: want, profile: null, routed: false, reason: "routing_off", from };
  if (!PROFILE_NAME_RE.test(want)) return { requested: want, profile: null, routed: false, reason: "not_configured", from };
  const r = routeFor(want, s);
  if (!r) return { requested: want, profile: null, routed: false, reason: "not_configured", from };
  if (!routeKeyPresent(r)) return { requested: want, profile: null, routed: false, reason: "missing_key", from };
  return { requested: want, profile: want, routed: true, reason: "routed", from };
}

/** Effective base URL for a route (no key). */
export function routeBaseUrl(r: AgentRoute, base = safeDefaultBase()) {
  return r.baseUrl ?? (base ? `${base.replace(/\/+$/, "")}/p/${encodeURIComponent(r.profile)}` : null);
}

function safeDefaultBase() {
  try {
    return hermesConn("admin-connection-test").baseUrl;
  } catch {
    return null;
  }
}

/**
 * The Hermes connection for a profile. `null` = the default connection.
 * A conversation or job that was created on a profile keeps using it: if its
 * route has since been removed this fails clearly instead of silently asking
 * the default profile about a session it doesn't have.
 */
export function connForProfile(profile: string | null | undefined, purpose?: "admin-connection-test"): HermesConn {
  const base = hermesConn(purpose);
  const p = normalize(profile);
  if (!p) return base;
  const r = routeFor(p);
  if (!r) throw new UpstreamError("Hermes", "unsupported", `The ${p} agent isn't set up in Settings → Agents`);
  const apiKey = keyFor(r, base.apiKey || undefined);
  if (!apiKey) throw new UpstreamError("Hermes", "unsupported", `The ${p} agent's key isn't configured on the server`);
  return { baseUrl: routeBaseUrl(r, base.baseUrl)!, apiKey };
}

/** Status rows for Settings → Agents (no secrets). */
export function agentRouteStatus() {
  const s = getAgentSettings();
  const base = safeDefaultBase();
  return s.routes.map((r) => ({ ...r, effectiveBaseUrl: routeBaseUrl(r, base), keyPresent: routeKeyPresent(r), sharedKey: !r.keyEnv }));
}

/**
 * The agent mode for a node in the Areas tree: the nearest node (itself, then
 * its ancestors) whose settings set `agentMode`. Only the owner's items count.
 */
export function requestedAgentFor(userId: string, nodeId: string): { agentMode: string | null; from: AgentResolution["from"] } {
  const db = getDb();
  let id: string | null = nodeId;
  for (let n = 0; id && n < 100; n++) {
    const row: { id: string; title: string; parentId: string | null; settings: string | null } | undefined = db
      .select({ id: schema.workItems.id, title: schema.workItems.title, parentId: schema.workItems.parentId, settings: schema.workItems.settings })
      .from(schema.workItems)
      .where(and(eq(schema.workItems.id, id), eq(schema.workItems.userId, userId)))
      .get();
    if (!row) break;
    const mode = agentModeOf(row.settings);
    if (mode) return { agentMode: mode, from: { id: row.id, title: row.title } };
    id = row.parentId;
  }
  return { agentMode: null, from: null };
}

function agentModeOf(json: string | null) {
  if (!json) return null;
  try {
    const v = (JSON.parse(json) as { agentMode?: unknown }).agentMode;
    return typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null;
  } catch {
    return null;
  }
}

/** Who answers for new work under this node. */
export function resolveAgentForNode(userId: string, nodeId: string | null | undefined): AgentResolution {
  if (!nodeId) return resolveAgent(null);
  const r = requestedAgentFor(userId, nodeId);
  return resolveAgent(r.agentMode, r.from);
}
