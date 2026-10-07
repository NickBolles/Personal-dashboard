/** Which AI answers a conversation. Client-safe. */
export const ASSISTANT_BACKENDS = ["hermes", "claude"] as const;
export type AssistantBackend = (typeof ASSISTANT_BACKENDS)[number];

export const BACKEND_LABELS: Record<AssistantBackend, { label: string; description: string }> = {
  hermes: { label: "Hermes", description: "Your agent: tools, skills, memory and approvals. Slower, can act." },
  claude: { label: "Claude", description: "Direct to Claude: fast answers, no tools. Uses Jarvis context you attach." },
};

/** Models offered for the Claude backend (Claude Opus 5.5 is the default). */
export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (most capable)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (faster)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fastest)" },
] as const;
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Local (non-Hermes) ids. */
export const isLocalSession = (id: string) => id.startsWith("loc_");
export const isLocalRun = (id: string) => id.startsWith("lrn_");

export type AssistantStatus = {
  defaultBackend: AssistantBackend;
  backends: { id: AssistantBackend; label: string; available: boolean; reason?: string }[];
  claude: { model: string; effort: Effort; keySet: boolean; keyFromEnv: boolean };
};
