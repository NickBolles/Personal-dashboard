import { api } from "@/server/http/api";
import { exportJson } from "@/server/quick-actions";
export const GET = api(
  ({ user }) =>
    new Response(JSON.stringify(exportJson(user.id), null, 2), {
      headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="quick-actions.json"', "cache-control": "no-store" },
    }),
  { cap: "work.use" },
);
