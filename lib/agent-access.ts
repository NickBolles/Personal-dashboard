/**
 * Scoped agent tokens (docs/agent-tools.md): client-safe scope list, labels and the mint schema.
 * A token lets one Hermes profile act for the owner through Jarvis MCP (/api/mcp) only.
 * AI-excluded subtrees are invisible. No scope maps to finance.* module capabilities.
 */
import { z } from "zod";

export const AGENT_SCOPES = ["work.read", "work.write", "decisions.write", "runs.write", "conversations.file"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const AGENT_SCOPE_LABELS: Record<AgentScope, { label: string; hint: string }> = {
  "work.read": { label: "Read work", hint: "Areas, projects and items (never AI-excluded areas or credentials)" },
  "work.write": { label: "Write work", hint: "Create items, update status / next action / fields, add notes and links (undoable)" },
  "decisions.write": { label: "Ask you", hint: "Raise a Needs-you decision; destructive changes become a proposal for you" },
  "runs.write": { label: "Record runs", hint: "Register agent runs and their progress on items" },
  "conversations.file": { label: "File conversations", hint: "File the agent's own conversations into an area or item" },
};

/** Defaults offered when minting (everything but filing conversations). */
export const DEFAULT_AGENT_SCOPES: AgentScope[] = ["work.read", "work.write", "decisions.write", "runs.write"];

export const AGENT_TOKEN_PREFIX = "jva_";

/** Hermes profile names: lowercase letters, digits, - and _ (same as Settings → Agents routes). */
export const agentProfileSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "Use the Hermes profile name (letters, digits, - or _)");

export const mintAgentTokenSchema = z
  .object({
    name: z.string().trim().min(1, "Name it").max(60),
    profile: agentProfileSchema,
    scopes: z.array(z.enum(AGENT_SCOPES)).min(1, "Pick at least one scope").max(AGENT_SCOPES.length),
  })
  .strict();

export type AgentTokenView = {
  id: string;
  name: string;
  profile: string;
  scopes: AgentScope[];
  /** last 4 characters of the token */
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type MintedAgentToken = { token: string; view: AgentTokenView };

export function parseScopes(raw: string | null | undefined): AgentScope[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? (v.filter((s) => (AGENT_SCOPES as readonly string[]).includes(s as string)) as AgentScope[]) : [];
  } catch {
    return [];
  }
}
