/**
 * One isolated app server + mock upstream per Playwright worker (docs/ci.md).
 *
 * Playwright evaluates playwright.config.ts in the runner AND again in every worker process; the worker sets
 * TEST_PARALLEL_INDEX (0..workers-1, stable across worker restarts) before it loads the config. So everything
 * here that depends on "which server is mine" reads that index at call time: in a worker it is that worker's
 * slot, in the runner it is 0 (used only to start the servers).
 *
 * Server i listens on E2E_PORT + i (app, default 3200) and E2E_MOCK_PORT + i (mock, default 4020), has its own
 * fresh data dir (scripts/e2e-server.mjs), its own Hermes usage snapshot file and its own signed-in state
 * (e2e/.auth/state-<i>.json, written by onboarding.setup.ts). Nothing is shared between workers, so specs that
 * change server state only see the files that ran before them on the same worker.
 */
import path from "node:path";

const APP_BASE_PORT = Number(process.env.E2E_PORT ?? 3200);
const MOCK_BASE_PORT = Number(process.env.E2E_MOCK_PORT ?? 4020);

/** `--workers N`, `--workers=N`, `-j N`, `-jN` from the runner's argv (only numeric counts). */
export function workersFromArgv(argv: readonly string[]): number | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^(?:--workers=|-j)(\d+)$/.exec(a);
    if (m) return Number(m[1]);
    if ((a === "--workers" || a === "-j") && /^\d+$/.test(argv[i + 1] ?? "")) return Number(argv[i + 1]);
    // "50%" would start one server for several workers: every worker past the first would hit a dead port.
    if (/^(?:--workers|-j)(?:=|$)/.test(a)) throw new Error(`e2e needs a numeric worker count (one server per worker), got: ${a} ${argv[i + 1] ?? ""}`);
  }
  return undefined;
}

/**
 * How many workers (and so server pairs) this run uses: E2E_WORKERS, else a numeric `--workers` on the
 * command line, else 1. `npm run e2e -- --workers 3` sets E2E_WORKERS for you (scripts/e2e.mjs).
 */
export function serverCount(env: Record<string, string | undefined> = process.env, argv: readonly string[] = process.argv): number {
  const n = Number(env.E2E_WORKERS ?? workersFromArgv(argv) ?? 1);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** This process's server slot: the worker's parallel index, 0 in the runner. */
export function slot(): number {
  const n = Number(process.env.TEST_PARALLEL_INDEX ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export const appPort = (i = slot()) => APP_BASE_PORT + i;
export const mockPort = (i = slot()) => MOCK_BASE_PORT + i;
export const appUrl = (i = slot()) => `http://127.0.0.1:${appPort(i)}`;
export const mockUrl = (i = slot()) => `http://127.0.0.1:${mockPort(i)}`;
/** Signed-in storage state for server i (relative to the repo root, like the old e2e/.auth/state.json). */
export const authState = (i = slot()) => `e2e/.auth/state-${i}.json`;
/** Hermes usage snapshot server i reads (JARVIS_HERMES_USAGE_FILE; absolute: the server runs in .next/standalone). */
export const usageFile = (i = slot()) => path.resolve(`e2e/.tmp/hermes-usage-${i}.json`);
