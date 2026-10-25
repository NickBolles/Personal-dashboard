import "server-only";
import { aiSettingsSchema, DEFAULT_AI_SETTINGS, type AiSettings } from "@/lib/ai";
import { getSetting, setSetting } from "@/server/settings";

const KEY = "ai.settings";

/** Household AI settings (admin). Unknown/invalid stored fields fall back to defaults field by field. */
export function getAiSettings(): AiSettings {
  const raw = getSetting<Record<string, unknown>>(KEY) ?? {};
  const out: AiSettings = structuredClone(DEFAULT_AI_SETTINGS);
  const shape = aiSettingsSchema.shape;
  for (const [k, v] of Object.entries(raw)) {
    const field = shape[k as keyof typeof shape];
    if (!field) continue;
    const parsed = field.safeParse(v);
    if (parsed.success) (out as Record<string, unknown>)[k] = parsed.data;
  }
  return out;
}

export function saveAiSettings(patch: Partial<AiSettings>): AiSettings {
  const next = aiSettingsSchema.parse({ ...getAiSettings(), ...patch });
  setSetting(KEY, next);
  return next;
}
