/**
 * New-deploy detection for the installed PWA.
 *
 * The page knows the build it was compiled from (`NEXT_PUBLIC_JARVIS_BUILD`, baked in from
 * `JARVIS_VERSION` at `next build`); `/api/health` reports the build the server runs now. When they
 * differ, a newer release is live: the service worker is told (so it stops serving an older cached
 * HTML shell on a slow network) and the shell offers a reload / reloads on the next navigation.
 */

/** Builds we can't compare (local dev, tests, unset) never count as an update. */
export function comparableBuild(id: string | null | undefined): id is string {
  return typeof id === "string" && /^[0-9a-f]{7,64}$/i.test(id.trim());
}

/** True when the server runs a different, real build than the one this page was built from. */
export function isNewerBuild(mine: string | null | undefined, server: string | null | undefined): boolean {
  if (!comparableBuild(mine) || !comparableBuild(server)) return false;
  return mine.trim().toLowerCase() !== server.trim().toLowerCase();
}

export type BuildCheckDeps = {
  mine: string | null | undefined;
  /** Returns the server's build id (`/api/health` `version`), or null when unreachable. */
  fetchServerBuild: () => Promise<string | null>;
  now: () => number;
  /** Minimum gap between two checks (visibility flips can be very frequent on phones). */
  minGapMs?: number;
};

/**
 * Throttled checker. `check()` resolves with the newer server build id once one is seen (and keeps
 * returning it without another request), else null.
 */
export function createBuildChecker({ mine, fetchServerBuild, now, minGapMs = 60_000 }: BuildCheckDeps) {
  let last = -Infinity;
  let found: string | null = null;
  let inFlight: Promise<string | null> | null = null;
  return {
    async check(force = false): Promise<string | null> {
      if (found) return found;
      if (!comparableBuild(mine)) return null;
      if (inFlight) return inFlight;
      if (!force && now() - last < minGapMs) return null;
      last = now();
      inFlight = (async () => {
        try {
          const server = await fetchServerBuild();
          if (isNewerBuild(mine, server)) found = String(server).trim();
          return found;
        } catch {
          return null;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
    get found() {
      return found;
    },
  };
}

export async function fetchHealthBuild(signal?: AbortSignal): Promise<string | null> {
  const res = await fetch("/api/health", { cache: "no-store", credentials: "same-origin", signal });
  if (!res.ok) return null;
  const j = (await res.json()) as { version?: unknown };
  return typeof j.version === "string" ? j.version : null;
}

/** Tell the active service worker which build is newest (it then refuses older cached pages). */
export function announceBuildToWorker(build: string) {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "BUILD", build });
  } catch {
    // no worker (dev, tests, unsupported browser)
  }
}

/** Activate a waiting worker (if any), then reload onto the new build. */
export async function reloadOntoNewBuild() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.waiting?.postMessage("SKIP_WAITING");
  } catch {
    // ignore: a plain reload still fetches the new HTML (network-first)
  }
  window.location.reload();
}
