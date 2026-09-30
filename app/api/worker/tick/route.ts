import { api } from "@/server/http/api";
import { tick } from "@/server/worker";

/** Manually run one background cycle (refresh sources, derive alerts, deliver pushes). */
export const POST = api(async () => ({ ok: true, summary: await tick() }));
