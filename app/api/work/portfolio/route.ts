import { api } from "@/server/http/api";
import { releaseInfo } from "@/server/work/release";

export const dynamic = "force-dynamic";

/** Portfolio view: the running release (version, since when, migrations). Local reads only. */
export const GET = api(() => releaseInfo(), { cap: "work.use" });
