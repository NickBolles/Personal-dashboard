import { api } from "@/server/http/api";
import { listPublicIntegrations } from "@/integrations/store";

export const GET = api(() => ({ integrations: listPublicIntegrations() }), { cap: "admin" });
