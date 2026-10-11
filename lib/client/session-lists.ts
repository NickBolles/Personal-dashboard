"use client";

import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { SessionPage } from "@/lib/session-pages";

/** A mutation refreshes the head window, never replays all loaded history. */
export async function refreshSessionLists(client: QueryClient) {
  await client.cancelQueries({ queryKey: ["sessions"] });
  client.setQueriesData<InfiniteData<SessionPage, number>>(
    { queryKey: ["sessions"] },
    (old) => old && { pages: old.pages.slice(0, 1), pageParams: old.pageParams.slice(0, 1) },
  );
  return client.invalidateQueries({ queryKey: ["sessions"] });
}
