import { api } from "@/server/http/api";
import { demoPresets } from "@/integrations/demo";

/** Demo presets pointing at the bundled mock upstreams (only when JARVIS_MOCK_UPSTREAM_URL is set). */
export const GET = api(() => ({ presets: demoPresets() }), { cap: "admin" });
