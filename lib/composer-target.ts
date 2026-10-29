/**
 * The global "Ask Jarvis" composer (⌘K palette, desktop dock, phone orb) is area-contextual:
 * inside an area, project or item it asks that area's agent, files the conversation there
 * and attaches the node as context. Outside Areas it is plain Jarvis.
 */
import type { AgentResolution } from "./agents";

/** Context ref the server expands into the node's title, path and open items (server/agents/composer.ts). */
export const NODE_CTX_PREFIX = "@ctx:node:";
export const NODE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export type ComposerNode = { id: string; title: string; kind: string; path: string[]; areaId: string; areaTitle: string };

/** The work item a page is "inside", from its URL: Areas pages carry it as `?item=` (also `?node=`). */
export function nodeIdFromRoute(pathname: string, search: string | URLSearchParams | null | undefined): string | null {
  if (!pathname.startsWith("/areas")) return null;
  const params = typeof search === "string" ? new URLSearchParams(search) : (search ?? new URLSearchParams());
  const id = params.get("item") ?? params.get("node");
  return id && NODE_ID_RE.test(id) ? id : null;
}

/** A conversation page (`/chat/<id>`): its session id, so the composer can follow the area it is filed in. */
export function sessionIdFromRoute(pathname: string): string | null {
  const m = /^\/chat\/([^/?#]+)/.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

export type ComposerTarget = {
  /** who answers: the routed profile, else "Jarvis" */
  agent: string;
  routed: boolean;
  /** null = outside Areas (plain Jarvis, filed in Miscellaneous) */
  node: ComposerNode | null;
  /** areaId to file the conversation under */
  areaId: string | null;
  /** context line for the first run */
  context: string | undefined;
};

export const JARVIS_TARGET: ComposerTarget = { agent: "Jarvis", routed: false, node: null, areaId: null, context: undefined };

/**
 * Who answers the global composer. Routing off, no agent on the area, or a route without a key all answer
 * as Jarvis (the default profile) but still file the question under the open node with its context.
 * `useJarvis` = the owner switched the chip back to plain Jarvis.
 */
export function composerTargetFor(node: ComposerNode | null | undefined, agent: AgentResolution | null | undefined, useJarvis = false): ComposerTarget {
  if (!node || useJarvis) return JARVIS_TARGET;
  const routed = Boolean(agent?.routed && agent.profile);
  return {
    agent: routed ? agent!.profile! : "Jarvis",
    routed,
    node,
    areaId: node.id,
    context: `${NODE_CTX_PREFIX}${node.id}`,
  };
}

/** "Ask momentumchief · Momentum bets" / "Ask Jarvis". */
export function composerLabel(t: ComposerTarget) {
  return t.node ? `Ask ${t.agent} · ${t.node.title}` : "Ask Jarvis";
}
