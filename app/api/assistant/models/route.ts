import { api } from "@/server/http/api";
import { isConfigured } from "@/integrations/store";
import { hermesConn, HermesDiscoveryClient } from "@/integrations/hermes/client";
import { claudeConfig } from "@/server/assistant/settings";
import { CLAUDE_MODELS } from "@/lib/assistant";
import type { ModelOption, ModelsResponse } from "@/lib/assistant";

export const dynamic = "force-dynamic";

/** Provider entries from Hermes' /api/model/options may list their models (shape varies by Hermes version). */
function providerModels(p: unknown): ModelOption[] {
  if (!p || typeof p !== "object") return [];
  const o = p as { id?: unknown; name?: unknown; models?: unknown };
  const provider = typeof o.id === "string" ? o.id : undefined;
  if (!Array.isArray(o.models)) return [];
  return o.models.flatMap((m) => {
    const id = typeof m === "string" ? m : m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string" ? (m as { id: string }).id : null;
    return id ? [{ id, label: id, provider }] : [];
  });
}

/**
 * The model selector's real list: Hermes' /v1/models (plus models its
 * providers report), or the Claude-direct list. `?backend=hermes|claude`.
 */
export const GET = api(
  async ({ req }): Promise<ModelsResponse> => {
    if (req.nextUrl.searchParams.get("backend") === "claude") {
      const c = claudeConfig();
      return {
        backend: "claude",
        defaultModel: c.model,
        defaultProvider: null,
        models: CLAUDE_MODELS.map((m) => ({ id: m.id, label: m.label })),
        unavailable: false,
      };
    }
    if (!isConfigured("hermes")) return { backend: "hermes", defaultModel: null, defaultProvider: null, models: [], unavailable: true };
    const c = hermesConn();
    const [list, options] = await Promise.all([HermesDiscoveryClient.models(c).catch(() => null), HermesDiscoveryClient.modelOptions(c).catch(() => null)]);
    const seen = new Set<string>();
    const models: ModelOption[] = [];
    for (const m of [
      ...(list?.data ?? []).map((x) => ({ id: x.id, label: x.id, provider: x.owned_by ?? undefined })),
      ...(options?.providers ?? []).flatMap(providerModels),
    ]) {
      const k = `${m.provider ?? ""}|${m.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      models.push(m);
    }
    return { backend: "hermes", defaultModel: options?.model ?? null, defaultProvider: options?.provider ?? null, models, unavailable: !list && !options };
  },
  { cap: "hermes.chat" },
);
