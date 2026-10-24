import { api } from "@/server/http/api";
import { removeDependency } from "@/server/work/store";

export const DELETE = api<undefined, { id: string }>(({ user, params, correlationId }) => removeDependency(user, params.id, correlationId), {
  cap: "work.use",
});
