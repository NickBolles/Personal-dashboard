import { api } from "@/server/http/api";
import { accept } from "@/server/quick-actions";
import { quickActionPatch } from "@/lib/quick-actions";
export const POST = api(({ user, params, body }) => accept(user.id, params.id, body), { cap: "work.use", body: quickActionPatch });
