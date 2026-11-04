import { api } from "@/server/http/api";
import { create, list } from "@/server/quick-actions";
import { quickActionInput } from "@/lib/quick-actions";
export const GET = api(({ user, req }) => ({ actions: list(user.id, { scope: req.nextUrl.searchParams.get("scope") ?? undefined }) }), { cap: "work.use" });
export const POST = api(({ user, body }) => create(user.id, body), { cap: "work.use", body: quickActionInput });
