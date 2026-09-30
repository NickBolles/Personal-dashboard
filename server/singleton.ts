/**
 * Next.js compiles route handlers and instrumentation (the worker) into
 * separate bundles, so module-level state is NOT shared between them. State
 * that must be process-wide (token caches, rotation locks, counters) lives on
 * globalThis via this helper.
 */
export function processSingleton<T>(key: string, init: () => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  const k = `__jarvis_${key}`;
  if (!(k in g)) g[k] = init();
  return g[k] as T;
}
