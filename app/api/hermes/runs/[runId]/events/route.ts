import { api } from "@/server/http/api";
import { relayRunEvents } from "@/server/assistant";
import { getAgentSettings } from "@/server/agents/routing";

export const dynamic = "force-dynamic";

/**
 * SSE relay. Reconnect with Last-Event-ID (EventSource does this automatically) or ?lastSeq=.
 * `?format=agui` asks for AG-UI events; served only while Settings → Agents "AG-UI stream" is on
 * (older clients and the phone app never ask, so they keep Jarvis events).
 */
export const GET = api<undefined, { runId: string }>(
  ({ params, user, req }) => {
    const last = req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("lastSeq") ?? undefined;
    const format = req.nextUrl.searchParams.get("format") === "agui" && getAgentSettings().aguiStream ? "agui" : "jarvis";
    const stream = relayRunEvents(user, params.runId, last && /^\d+$/.test(last) ? last : undefined, req.signal, format);
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  },
  { cap: "hermes.chat" },
);
