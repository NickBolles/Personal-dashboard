import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * #180 / docs/agent-tools.md: who is making a write on the owner's behalf. Agent-token (MCP)
 * calls run inside `withVia("agent:<profile>", …)`; every work_event, work_op and item write
 * made inside records it, so Activity and item rows can say "by @profile". Outside an agent
 * call it is null (the person themselves). AsyncLocalStorage, so concurrent requests never mix.
 */
const store = new AsyncLocalStorage<{ via: string }>();

export function withVia<T>(via: string, fn: () => T): T {
  return store.run({ via }, fn);
}

export function currentVia(): string | null {
  return store.getStore()?.via ?? null;
}

/** "agent:chiefofstaff" → "chiefofstaff" (null for anything else). */
export function agentProfileOf(via: string | null | undefined): string | null {
  return via?.startsWith("agent:") ? via.slice(6) || null : null;
}
