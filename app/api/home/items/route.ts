import { z } from "zod";
import { api } from "@/server/http/api";
import { homeSelection } from "@/server/sources";
import type { HomeItemsPage } from "@/lib/contracts";

export const dynamic = "force-dynamic";

const query = z.object({
  bucket: z.enum(["now", "today", "upcoming", "backlog"]),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** "See all": one Home bucket, ranked exactly like Home, paged. Reads cached snapshots only. */
export const GET = api(async ({ req, user }): Promise<HomeItemsPage> => {
  const q = query.parse(Object.fromEntries(req.nextUrl.searchParams));
  const { attention } = await homeSelection(user, { live: false });
  const list = attention[q.bucket];
  const next = q.offset + q.limit;
  return { bucket: q.bucket, items: list.slice(q.offset, next), total: list.length, offset: q.offset, nextOffset: next < list.length ? next : undefined };
});
