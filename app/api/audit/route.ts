import { api } from "@/server/http/api";
import { recentAudit } from "@/server/audit";

export const GET = api(() => ({ entries: recentAudit(200) }));
