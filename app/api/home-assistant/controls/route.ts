import { api } from "@/server/http/api";
import { listControls } from "@/integrations/home-assistant/controls";

export const dynamic = "force-dynamic";

/** Live state for allowlisted controls. Never cached: controls require current state. */
export const GET = api(async () => ({ controls: await listControls(), fetchedAt: new Date().toISOString() }));
