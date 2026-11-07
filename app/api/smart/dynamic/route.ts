import { api } from "@/server/http/api";
import { dynamicCards } from "@/server/smart/dynamic";
export const dynamic = "force-dynamic";
/** Owner-only deterministic cards. No Finance, models or external writes. */
export const GET = api(({ user, req }) => dynamicCards(user, new Date(), req.nextUrl.searchParams.get("card") ?? undefined), { cap: "work.use" });
