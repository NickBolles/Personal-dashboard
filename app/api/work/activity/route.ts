import { api } from "@/server/http/api";
import { listActivity } from "@/server/work/activity";
import { ACTIVITY_TYPES, type ActivityType, type ActorKind } from "@/lib/activity";

const ACTORS: ActorKind[] = ["you", "agent", "github", "system"];

/** Unified activity timeline (lib/activity.ts): ?item=&descendants=1&type=a,b&actor=&q=&cursor=&limit= */
export const GET = api(
  ({ req, user }) => {
    const p = req.nextUrl.searchParams;
    const types = (p.get("type") ?? "").split(",").filter((t): t is ActivityType => (ACTIVITY_TYPES as readonly string[]).includes(t));
    const actor = p.get("actor");
    return listActivity(user, {
      item: p.get("item") || null,
      descendants: p.get("descendants") === "1",
      types,
      actor: actor && (ACTORS as string[]).includes(actor) ? (actor as ActorKind) : null,
      q: (p.get("q") ?? "").slice(0, 200) || null,
      cursor: p.get("cursor"),
      limit: Number(p.get("limit")) || 50,
    });
  },
  { cap: "work.use" },
);
