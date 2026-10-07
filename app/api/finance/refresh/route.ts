import { api } from "@/server/http/api";
import { refreshFromMonarch } from "@/server/finance/sync";

/** Refresh-and-read from Monarch. Reports partial/failed honestly; never substitutes manual data. */
export const POST = api(({ user, correlationId }) => refreshFromMonarch(user.id, correlationId), { cap: "finance.edit" });
