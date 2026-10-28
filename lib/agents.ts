import { z } from "zod";

/**
 * Agents (Coordinators slice C1): which Hermes profile answers where.
 *
 * Hermes serves every named profile on the same API server under `/p/<profile>/…`
 * when `gateway.multiplex_profiles` is on, and each profile authenticates with its
 * own `API_SERVER_KEY` (profile-scoped secret; it never inherits the default key).
 * Jarvis keeps one route per profile: the env var that holds that key (in the
 * Jarvis secrets env file, never in the DB) and an optional base URL override for
 * a profile that runs its own API server.
 */

/** Hermes profile ids: lowercase, digits, `-`/`_` (hermes_cli/profiles.py). */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Key refs are restricted to this prefix so a route can never point at an unrelated secret. */
export const KEY_ENV_PREFIX = "JARVIS_HERMES_KEY_";
export const KEY_ENV_RE = /^JARVIS_HERMES_KEY_[A-Z0-9_]{1,64}$/;

/** The env var name we suggest for a profile: momentumchief → JARVIS_HERMES_KEY_MOMENTUMCHIEF. */
export const suggestedKeyEnv = (profile: string) => `${KEY_ENV_PREFIX}${profile.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

export const agentRouteSchema = z.object({
  profile: z.string().trim().regex(PROFILE_NAME_RE, "Use the Hermes profile id, e.g. momentumchief"),
  /** null/blank = reuse the main Hermes connection key (shared API_SERVER_KEY on the profile) */
  keyEnv: z
    .string()
    .trim()
    .regex(KEY_ENV_RE, `Use an env var starting with ${KEY_ENV_PREFIX}`)
    .or(z.literal(""))
    .nullable()
    .optional()
    .transform((v) => v || null),
  /** null = the Hermes connection's base URL + /p/<profile> */
  baseUrl: z
    .string()
    .trim()
    .max(300)
    .nullable()
    .transform((v) => (v ? v.replace(/\/+$/, "") : null))
    .refine((v) => v === null || /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(v), "Use an http(s) URL"),
});
export type AgentRoute = z.infer<typeof agentRouteSchema>;

export const agentSettingsSchema = z.object({
  /** route chats/AI jobs to the area's profile (off: the profile name is only a text hint, as before) */
  routing: z.boolean(),
  /** stream chat runs to the browser as AG-UI events (server/agui) instead of Jarvis RunEvents */
  aguiStream: z.boolean(),
  routes: z
    .array(agentRouteSchema)
    .max(20)
    .refine((r) => new Set(r.map((x) => x.profile)).size === r.length, "Each profile can only have one route"),
});
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export const agentSettingsPatchSchema = agentSettingsSchema.partial();

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { routing: false, aguiStream: false, routes: [] };

/** Why a requested profile is (not) answering. */
export type AgentReason = "routed" | "default" | "routing_off" | "not_configured" | "missing_key" | "started_on_default";

/** Who answers: `profile` is the Hermes profile that actually runs (null = Hermes' default profile). */
export type AgentResolution = {
  /** the area/item's agent mode (inherited up the tree), if any */
  requested: string | null;
  profile: string | null;
  routed: boolean;
  reason: AgentReason;
  /** where the requested agent mode came from */
  from?: { id: string; title: string } | null;
};

export const AGENT_REASON_TEXT: Record<AgentReason, string> = {
  routed: "Runs on this Hermes profile",
  default: "Hermes default profile",
  routing_off: "Profile routing is off, so the profile name is sent as a hint to the default profile",
  not_configured: "No route for this profile in Settings → Agents, so it is sent as a hint to the default profile",
  missing_key: "This profile's key isn't in the Jarvis secrets file yet, so it is sent as a hint to the default profile",
  started_on_default: "This conversation started on the default profile. New conversations here use the area's profile",
};

/** Label for the composer/area chip. */
export function agentChipLabel(a: Pick<AgentResolution, "profile" | "requested" | "routed">) {
  if (a.routed && a.profile) return a.profile;
  if (a.requested) return `${a.requested} (hint)`;
  return "default";
}
