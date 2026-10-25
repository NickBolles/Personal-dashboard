import { z } from "zod";
import { api } from "@/server/http/api";
import { startRun } from "@/server/assistant";
import { getPreferences } from "@/server/settings";
import { buildContext, CONTEXT_SOURCES, contextAllowed } from "@/server/context";
import { areaDefaultsFor, resolveReferences } from "@/server/references";
import { parseReferences } from "@/lib/references";

const schema = z.object({
  input: z.string().min(1).max(50000),
  idempotencyKey: z.string().min(8).max(255),
  model: z.string().max(100).optional(),
  provider: z.string().max(100).optional(),
  context: z.string().max(4000).optional(),
  /** attach a server-built snapshot of these sources ("Ask about Skylight") */
  contextSources: z.array(z.enum(CONTEXT_SOURCES)).max(CONTEXT_SOURCES.length).optional(),
});

/**
 * Start a turn. Model/provider: the message's override, else the
 * conversation's area default (Areas), else the household preference.
 * `@`/`#` reference tokens in the input are resolved into context snapshots
 * (only what this person may see; never Finance), and the area's default
 * context sources are attached too.
 */
export const POST = api<z.infer<typeof schema>, { id: string }>(
  async ({ params, body, user, correlationId }) => {
    const prefs = getPreferences().hermes;
    const area = areaDefaultsFor(user, params.id);
    const sources = [...new Set([...(body.contextSources ?? []), ...(area?.settings.contextSources ?? []).filter((s) => contextAllowed(user, s))])];
    const refs = await resolveReferences(user, parseReferences(body.input));
    const extra = [refs, body.context].filter(Boolean).join("\n\n") || undefined;
    const context = await buildContext(user, sources, extra);
    const input = context ? `${body.input}\n\n---\nContext from Jarvis:\n${context}` : body.input;
    const s = area?.settings;
    const instructions =
      s && (s.agentMode || s.instructions)
        ? [`Jarvis area: ${area!.area.title}.`, s.agentMode ? `Agent mode: ${s.agentMode}.` : "", s.instructions ?? ""].filter(Boolean).join(" ")
        : undefined;
    return startRun(
      user,
      {
        sessionId: params.id,
        input,
        idempotencyKey: body.idempotencyKey,
        model: body.model || s?.defaultModel || prefs.defaultModel || undefined,
        provider: body.provider || (body.model ? undefined : s?.defaultProvider) || prefs.defaultProvider || undefined,
        instructions,
      },
      correlationId,
    );
  },
  { body: schema, cap: "hermes.chat" },
);
