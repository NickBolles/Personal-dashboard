import { api } from "@/server/http/api";
import { agentRuns } from "@/server/work/agent-runs";

/** Agent runs on items (read-only): who is on each item, live run state, PRs and last report. */
export const GET = api(({ user }) => agentRuns(user), { cap: "work.use" });
