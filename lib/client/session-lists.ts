"use client";

import type { QueryClient } from "@tanstack/react-query";

/**
 * useSessions bounds refreshes to the head, preserving history until success.
 * Areas lists (the conversations view, the tree's conversation rows) refresh too.
 */
export async function refreshSessionLists(client: QueryClient) {
  await client.cancelQueries({ queryKey: ["sessions"] });
  void client.invalidateQueries({ queryKey: ["work"] });
  return client.invalidateQueries({ queryKey: ["sessions"] });
}
