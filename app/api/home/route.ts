import { api } from "@/server/http/api";
import { getHome } from "@/server/sources";

export const dynamic = "force-dynamic";

/** ?cached=1 returns last-known snapshots instantly; otherwise sources are fetched live (bounded, with timeouts). */
export const GET = api(({ req }) => getHome({ live: req.nextUrl.searchParams.get("cached") !== "1" }));
