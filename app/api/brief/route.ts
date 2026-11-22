import { api } from "@/server/http/api";
import { BRIEF_CAP, getBriefView } from "@/server/brief";

export const dynamic = "force-dynamic";

/**
 * Today's brief for this person: the last AI build, or the rules brief computed
 * from cached Home data. Never calls a model or an upstream (docs/brief.md).
 */
export const GET = api(({ user }) => getBriefView(user), { cap: BRIEF_CAP });
