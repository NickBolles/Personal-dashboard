import { api } from "@/server/http/api";
import { mapData } from "@/server/work/decisions";

/** /map: items + links + the "Needs you" list in one read. */
export const GET = api(({ user }) => mapData(user), { cap: "work.use" });
