import "server-only";
import { processSingleton } from "@/server/singleton";

/**
 * Cross-module hooks without static imports, so modules that must not reach integration code
 * (server/ai/**, see test/ai-rules.test.ts) can still wake the capture-triage applier, and the
 * decision store can hand an owner's answer to it. Registered once at startup (instrumentation.ts);
 * the dispatcher tick is the fallback when a hook isn't set (tests, other bundles).
 */
type Hooks = {
  /** a capture_triage row became `planned` */
  triagePlanned: (() => void) | null;
  /** the owner answered a decision (non-repeated) */
  decisionAnswered: ((d: { userId: string; decisionId: string; answer: string }) => void) | null;
};

export const hooks = () => processSingleton<Hooks>("jarvis_hooks", () => ({ triagePlanned: null, decisionAnswered: null }));

export function fireHook<K extends keyof Hooks>(name: K, ...args: Parameters<NonNullable<Hooks[K]>>) {
  const fn = hooks()[name] as ((...a: unknown[]) => void) | null;
  if (!fn) return;
  try {
    fn(...args);
  } catch (e) {
    console.error(`[jarvis] hook ${name} failed`, (e as Error).message.slice(0, 200));
  }
}
