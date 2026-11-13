"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button, Toast } from "@/components/ui";
import { announceBuildToWorker, createBuildChecker, fetchHealthBuild, reloadOntoNewBuild } from "@/lib/client/build-update";

const MINE = process.env.NEXT_PUBLIC_JARVIS_BUILD;
const POLL_MS = 15 * 60_000;

/**
 * Picks up new deploys in a long-lived PWA window: checks `/api/health` when the app comes back to
 * the foreground (and every 15 min while visible). Once a newer build is live it shows a compact
 * "Updated — reload" toast, and the next in-app navigation becomes a full load of the new build.
 */
export function BuildUpdate() {
  const pathname = usePathname();
  const [update, setUpdate] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const shownAt = useRef<string | null>(null);

  useEffect(() => {
    const checker = createBuildChecker({ mine: MINE, fetchServerBuild: () => fetchHealthBuild(), now: () => Date.now() });
    let alive = true;
    const run = (force = false) => {
      if (document.visibilityState !== "visible") return;
      void checker.check(force).then((b) => {
        if (!alive || !b) return;
        announceBuildToWorker(b);
        setUpdate(b);
      });
    };
    const onVisible = () => run();
    const onOnline = () => run(true);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    const t = window.setInterval(() => run(true), POLL_MS);
    run(true);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.clearInterval(t);
    };
  }, []);

  // Next navigation after an update was found: load the new build instead of the old bundle.
  useEffect(() => {
    if (!update) return;
    if (shownAt.current === null) {
      shownAt.current = pathname;
      return;
    }
    if (shownAt.current !== pathname) void reloadOntoNewBuild();
  }, [update, pathname]);

  if (!update || dismissed) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-28 z-50 flex justify-center px-4 lg:bottom-6" data-build-update={update.slice(0, 7)}>
      <div className="pointer-events-auto flex items-center gap-1">
        <Toast message="Jarvis updated" action={{ label: "Reload", onClick: () => void reloadOntoNewBuild() }} />
        <Button variant="ghost" size="sm" aria-label="Dismiss update notice" onClick={() => setDismissed(true)}>
          Later
        </Button>
      </div>
    </div>
  );
}
