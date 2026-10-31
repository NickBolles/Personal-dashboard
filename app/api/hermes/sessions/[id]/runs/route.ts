import { requestedAgentFor } from "@/server/agents/routing";
import { z } from "zod";
import { api } from "@/server/http/api";
import { startRun } from "@/server/assistant";
import { getPreferences } from "@/server/settings";
import { buildContext, CONTEXT_SOURCES, contextAllowed } from "@/server/context";
import { areaDefaultsFor, resolveReferences } from "@/server/references";
import { parseReferences } from "@/lib/references";
import { resolveContextRefs } from "@/server/smart/context";
import { getSmartSettings } from "@/server/smart/store";
import { smartInstructions } from "@/server/smart/prompt";
import { SMART_CAPABILITY } from "@/lib/jarvis-ui/types";
import { sessionProfile } from "@/integrations/hermes/service";
import { isLocalSession } from "@/lib/assistant";
import { CHAT_FILE_LIMITS } from "@/lib/chat-files";
import { markFilesSent, prepareRunFiles } from "@/server/chat/files";

const schema = z.object({
  input: z.string().min(1).max(50000),
  idempotencyKey: z.string().min(8).max(255),
  model: z.string().max(100).optional(),
  provider: z.string().max(100).optional(),
  context: z.string().max(4000).optional(),
  /** attach a server-built snapshot of these sources ("Ask about Skylight") */
  contextSources: z.array(z.enum(CONTEXT_SOURCES)).max(CONTEXT_SOURCES.length).optional(),
  /** renderers this client has (web: ["jarvis-ui@1"]); smart-reply instructions are added only when declared */
  capabilities: z.array(z.string().max(40)).max(8).optional(),
  /** draft attachments uploaded to /files for this conversation */
  files: z.array(z.string().max(80)).max(CHAT_FILE_LIMITS.perMessage).optional(),
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
    // @ctx: refs (e.g. all overdue todos) are built here, after the 6 000-char
    // context cap, so they are never cut to "…and N more" (≤ 8 000 chars each).
    const resolved = resolveContextRefs(user, body.context);
    const extra = [refs, resolved.context].filter(Boolean).join("\n\n") || undefined;
    const files = body.files?.length ? await prepareRunFiles(user, params.id, body.files) : null;
    // Images can only reach Hermes; the on-device assistant gets a note instead.
    const local = isLocalSession(params.id);
    const imageNote = local && files?.imageUrls.length ? `(${files.imageUrls.length} picture(s) attached — this assistant can't see pictures)` : "";
    const context = [await buildContext(user, sources, extra), ...resolved.blocks, ...(files?.textBlocks ?? []), imageNote, files?.marker]
      .filter(Boolean)
      .join("\n\n");
    const input = context ? `${body.input}\n\n---\nContext from Jarvis:\n${context}` : body.input;
    const s = area?.settings;
    // The agent-mode hint is only for conversations NOT already running on that Hermes profile (Settings → Agents).
    const onProfile = isLocalSession(params.id) ? null : sessionProfile(params.id);
    // Same nearest-ancestor walk as routing, so a project's override beats its area's mode.
    const agentMode = area ? requestedAgentFor(user.id, area.nodeId).agentMode : null;
    const modeHint = agentMode && agentMode.trim().toLowerCase() !== onProfile ? agentMode : null;
    const areaInstructions =
      s && (modeHint || s.instructions)
        ? [`Jarvis area: ${area!.area.title}.`, modeHint ? `Agent mode: ${modeHint}.` : "", s.instructions ?? ""].filter(Boolean).join(" ")
        : undefined;
    const smart = body.capabilities?.includes(SMART_CAPABILITY) && getSmartSettings(user.id).enabled ? smartInstructions() : undefined;
    const instructions = [areaInstructions, smart].filter(Boolean).join("\n\n") || undefined;
    const run = await startRun(
      user,
      {
        sessionId: params.id,
        input,
        ...(files?.imageUrls.length && !local ? { images: files.imageUrls } : {}),
        idempotencyKey: body.idempotencyKey,
        model: body.model || s?.defaultModel || prefs.defaultModel || undefined,
        provider: body.provider || (body.model ? undefined : s?.defaultProvider) || prefs.defaultProvider || undefined,
        // The chat default's reasoning effort applies only when the run uses the default model.
        ...(prefs.defaultReasoning && !body.model && !s?.defaultModel ? { modelOptions: { reasoning: { effort: prefs.defaultReasoning } } } : {}),
        instructions,
      },
      correlationId,
    );
    if (files) markFilesSent(files.ids, run.runId);
    return run;
  },
  { body: schema, cap: "hermes.chat" },
);
