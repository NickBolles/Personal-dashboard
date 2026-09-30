import { api } from "@/server/http/api";
import { getRun } from "@/integrations/hermes/service";

export const dynamic = "force-dynamic";

export const GET = api<undefined, { runId: string }>(({ params, user }) => getRun(user, params.runId));
