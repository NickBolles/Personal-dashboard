import { api } from "@/server/http/api";
import { relayRunEvents } from "@/integrations/hermes/service";

export const dynamic = "force-dynamic";

/** SSE relay. Reconnect with Last-Event-ID (EventSource does this automatically) or ?lastSeq=. */
export const GET = api<undefined, { runId: string }>(({ params, user, req }) => {
  const last = req.headers.get("last-event-id") ?? req.nextUrl.searchParams.get("lastSeq") ?? undefined;
  const stream = relayRunEvents(user, params.runId, last && /^\d+$/.test(last) ? last : undefined, req.signal);
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});
