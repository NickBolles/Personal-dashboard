import { api } from "@/server/http/api";
import { createItemSchema } from "@/lib/work";
import { createItem, listItems } from "@/server/work/store";

export const GET = api(({ req, user }) => ({ items: listItems(user.id, { includeArchived: req.nextUrl.searchParams.get("archived") === "1" }) }), {
  cap: "work.use",
});
export const POST = api(({ user, body, correlationId }) => ({ item: createItem(user, body, correlationId) }), { cap: "work.use", body: createItemSchema });
