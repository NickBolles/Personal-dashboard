import { api } from "@/server/http/api";
import { deleteTemplate } from "@/server/work/store";

export const DELETE = api<undefined, { id: string }>(({ user, params, correlationId }) => deleteTemplate(user, params.id, correlationId), { cap: "work.use" });
