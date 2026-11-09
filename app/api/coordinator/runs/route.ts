import { api } from "@/server/http/api";
import { lastLooked, listRunEvents, runTree } from "@/server/work/run-events";

export const GET = api(
  ({ user }) => {
    const { runs } = runTree(user);
    return { runs, events: listRunEvents(user.id, { runIds: runs.map((r) => r.id), limit: 100 }), lastLooked: lastLooked(user.id) };
  },
  { cap: "work.use" },
);
