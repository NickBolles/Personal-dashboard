"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { useAccess } from "@/components/access";
import type { AgentResolution } from "@/lib/agents";
import { composerTargetFor, nodeIdFromRoute, sessionIdFromRoute, type ComposerNode, type ComposerTarget } from "@/lib/composer-target";

/**
 * Where the global composer is "standing": the Areas node or conversation in the URL, and whether the
 * owner switched the chip back to plain Jarvis (reset whenever the page's node changes).
 */
type RouteState = { nodeId: string | null; sessionId: string | null; jarvis: boolean };
let state: RouteState = { nodeId: null, sessionId: null, jarvis: false };
const listeners = new Set<() => void>();
const set = (next: Partial<RouteState>) => {
  const merged = { ...state, ...next };
  if (merged.nodeId === state.nodeId && merged.sessionId === state.sessionId && merged.jarvis === state.jarvis) return;
  state = merged;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => state;

/** Mounted once in the shell (inside <Suspense>: it reads search params). */
export function ComposerRouteWatcher() {
  const pathname = usePathname() ?? "";
  const search = useSearchParams();
  const nodeId = nodeIdFromRoute(pathname, search?.toString() ?? "");
  const sessionId = nodeId ? null : sessionIdFromRoute(pathname);
  useEffect(() => {
    if (nodeId !== state.nodeId || sessionId !== state.sessionId) set({ nodeId, sessionId, jarvis: false });
  }, [nodeId, sessionId]);
  return null;
}

/** The owner's chip: switch this page's composer to plain Jarvis (or back to the area's agent). */
export const setComposerJarvis = (jarvis: boolean) => set({ jarvis });

export type ComposerTargetState = ComposerTarget & { loading: boolean; switchedToJarvis: boolean; available: boolean };

export function useComposerTarget(): ComposerTargetState {
  const { can } = useAccess();
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  const enabled = can("work.use") && can("hermes.chat") && Boolean(s.nodeId || s.sessionId);
  const q = useQuery({
    queryKey: ["agents", "composer", s.nodeId ?? "", s.sessionId ?? ""],
    queryFn: () =>
      api.get<{ node: ComposerNode | null; agent: AgentResolution }>(
        `/api/agents/composer?${s.nodeId ? `nodeId=${encodeURIComponent(s.nodeId)}` : `sessionId=${encodeURIComponent(s.sessionId!)}`}`,
      ),
    enabled,
    staleTime: 60_000,
  });
  const node = enabled ? (q.data?.node ?? null) : null;
  const target = composerTargetFor(node, q.data?.agent, s.jarvis);
  return { ...target, loading: enabled && q.isLoading, switchedToJarvis: s.jarvis && Boolean(node), available: Boolean(node) };
}
