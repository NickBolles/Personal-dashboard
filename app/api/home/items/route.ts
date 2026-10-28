import { z } from "zod";
import { api } from "@/server/http/api";
import { homeSelection } from "@/server/sources";
import type { HomeItemsPage } from "@/lib/contracts";
import { sourceFilterOptions, taskSourceLabel } from "@/lib/task-source";

export const dynamic = "force-dynamic";

const query = z.object({
  bucket: z.enum(["now", "today", "upcoming", "backlog"]),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Source chip label to filter by (lib/task-source.ts); filtered before paging. */
  source: z.string().max(200).optional(),
});

/** "See all": one Home bucket, ranked exactly like Home, paged. Reads cached snapshots only. */
export const GET = api(async ({ req, user }): Promise<HomeItemsPage> => {
  const q = query.parse(Object.fromEntries(req.nextUrl.searchParams));
  const { attention } = await homeSelection(user, { live: false });
  const bucket = attention[q.bucket];
  const list = q.source ? bucket.filter((a) => taskSourceLabel(a) === q.source) : bucket;
  const next = q.offset + q.limit;
  return {
    bucket: q.bucket,
    items: list.slice(q.offset, next),
    total: list.length,
    offset: q.offset,
    nextOffset: next < list.length ? next : undefined,
    sources: sourceFilterOptions(bucket),
  };
});
