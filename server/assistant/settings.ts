import "server-only";
import { decrypt, encrypt } from "@/server/crypto";
import { getSetting, setSetting } from "@/server/settings";
import { isConfigured } from "@/integrations/store";
import { BACKEND_LABELS, DEFAULT_CLAUDE_MODEL, type AssistantBackend, type AssistantStatus, type Effort } from "@/lib/assistant";

/**
 * Household assistant settings. The Anthropic API key is encrypted at rest,
 * never returned to the browser and never logged; ANTHROPIC_API_KEY (or an
 * `ant auth login` profile on the server) is used when none is saved.
 */
const KEY = "assistant_settings";

type Stored = { defaultBackend?: AssistantBackend; claude?: { model?: string; effort?: Effort; apiKey?: string } };

function stored(): Stored {
  return getSetting<Stored>(KEY) ?? {};
}

export function claudeConfig() {
  const s = stored().claude ?? {};
  let apiKey: string | undefined;
  try {
    apiKey = s.apiKey ? decrypt(s.apiKey) : undefined;
  } catch {
    apiKey = undefined;
  }
  return {
    model: s.model ?? DEFAULT_CLAUDE_MODEL,
    effort: s.effort ?? ("low" as Effort),
    apiKey,
    keyFromEnv: !apiKey && Boolean(process.env.ANTHROPIC_API_KEY),
  };
}

export function claudeAvailable() {
  const c = claudeConfig();
  return Boolean(c.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function backendAvailable(b: AssistantBackend) {
  return b === "hermes" ? isConfigured("hermes") : claudeAvailable();
}

export function defaultBackend(): AssistantBackend {
  const want = stored().defaultBackend ?? "hermes";
  if (backendAvailable(want)) return want;
  return (["hermes", "claude"] as const).find(backendAvailable) ?? want;
}

export function assistantStatus(): AssistantStatus {
  const c = claudeConfig();
  return {
    defaultBackend: defaultBackend(),
    backends: (["hermes", "claude"] as const).map((id) => ({
      id,
      label: BACKEND_LABELS[id].label,
      available: backendAvailable(id),
      reason: backendAvailable(id) ? undefined : id === "hermes" ? "Connect Hermes in Settings → Connections" : "Add an Anthropic API key",
    })),
    claude: { model: c.model, effort: c.effort, keySet: Boolean(c.apiKey), keyFromEnv: c.keyFromEnv },
  };
}

export function saveAssistantSettings(patch: { defaultBackend?: AssistantBackend; model?: string; effort?: Effort; apiKey?: string | null }) {
  const s = stored();
  const claude = { ...(s.claude ?? {}) };
  if (patch.model) claude.model = patch.model;
  if (patch.effort) claude.effort = patch.effort;
  if (patch.apiKey === null || patch.apiKey === "") delete claude.apiKey;
  else if (patch.apiKey) claude.apiKey = encrypt(patch.apiKey.trim());
  setSetting(KEY, { ...s, ...(patch.defaultBackend ? { defaultBackend: patch.defaultBackend } : {}), claude });
  return assistantStatus();
}
