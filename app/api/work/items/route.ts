import { api } from "@/server/http/api";
import { createItemSchema, type ItemsResponse } from "@/lib/work";
import { createItem, linkedConversationRows, listItems } from "@/server/work/store";

/** The Areas tree: items (incl. conversation nodes) plus conversations linked to items, shown as their child rows. */
export const GET = api(
  ({ req, user }): ItemsResponse => {
    const items = listItems(user.id, { includeArchived: req.nextUrl.searchParams.get("archived") === "1" });
    return { items, linkedConversations: linkedConversationRows(user.id, items) };
  },
  { cap: "work.use" },
);
export const POST = api(({ user, body, correlationId }) => ({ item: createItem(user, body, correlationId) }), { cap: "work.use", body: createItemSchema });
