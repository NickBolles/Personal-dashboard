import { api } from "@/server/http/api";
import { getVapid } from "@/server/notifications/push";

export const GET = api(() => ({ publicKey: getVapid().publicKey }));
