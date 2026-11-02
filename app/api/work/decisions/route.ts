import { api } from "@/server/http/api";
import { listDecisions } from "@/server/work/decisions";

/** "Needs you": owner decisions, Hermes approvals and workflow proposals (read-only). */
export const GET = api(({ user }) => listDecisions(user), { cap: ["work.use", "hermes.chat"] });
