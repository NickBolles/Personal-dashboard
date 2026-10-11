"use client";

import type { QueryClient } from "@tanstack/react-query";

/** useSessions bounds refreshes to the head, preserving history until success. */
export async function refreshSessionLists(client: QueryClient) {
  await client.cancelQueries({ queryKey: ["sessions"] });
  return client.invalidateQueries({ queryKey: ["sessions"] });
}
