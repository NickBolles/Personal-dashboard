import { api } from "@/server/http/api";
import { getRun } from "@/server/assistant";

export const dynamic = "force-dynamic";

export const GET = api<undefined, { runId: string }>(({ params, user }) => getRun(user, params.runId), { cap: "hermes.chat" });
