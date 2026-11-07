import { api } from "@/server/http/api";
import { exportFeedback } from "@/server/feedback/store";
export const dynamic = "force-dynamic";

export const GET = api(
  ({ user }) =>
    new Response(JSON.stringify(exportFeedback(user), null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="jarvis-feedback-${new Date().toISOString().slice(0, 10)}.json"`,
      },
    }),
  { cap: "hermes.chat" },
);
