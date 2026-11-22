import { api } from "@/server/http/api";
import { suggestionActionSchema } from "@/lib/suggestions";
import { actOnSuggestion, getSuggestion } from "@/server/work/suggestions";

export const dynamic = "force-dynamic";

/** One suggestion as it stands (a card in a chat). Null once it was dismissed or no longer applies. */
export const GET = api<undefined, { id: string }>(({ user, params }) => ({ suggestion: getSuggestion(user, params.id) }), { cap: "work.use" });

/**
 * The owner's answer to a card: Start or Send (their tap is the go-ahead), Not now, Show again, Don't suggest
 * this, Allow again, Undo a Start.
 */
export const POST = api(({ user, body, params, correlationId }) => actOnSuggestion(user, (params as { id: string }).id, body.action, correlationId), {
  body: suggestionActionSchema,
  capAll: ["work.use", "hermes.chat"],
});
