import { api } from "@/server/http/api";
import { contextRefCounts } from "@/server/smart/context";

export const dynamic = "force-dynamic";

/** Row counts behind `@ctx:` refs, so the composer shows "Overdue tasks (12)" instead of the raw ref. Counts only, no titles. */
export const GET = api(({ user }) => ({ counts: contextRefCounts(user) }), { cap: ["hermes.chat", "work.use"] });
