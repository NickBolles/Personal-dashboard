import { api } from "@/server/http/api";
import { listInitiatives } from "@/integrations/paperclip/service";

export const dynamic = "force-dynamic";

export const GET = api(() => listInitiatives());
