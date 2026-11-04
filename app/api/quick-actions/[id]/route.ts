import { api } from "@/server/http/api";
import { update, remove } from "@/server/quick-actions";
import { quickActionPatch } from "@/lib/quick-actions";
export const PATCH = api(({ user, params, body }) => update(user.id, params.id, body), { cap: "work.use", body: quickActionPatch });
export const DELETE = api(({ user, params }) => remove(user.id, params.id), { cap: "work.use" });
