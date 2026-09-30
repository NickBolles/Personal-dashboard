"use client";

import { useEffect, useState } from "react";
import { Badge, Button } from "@/components/ui";

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: BIPEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BIPEvent;
    listeners.forEach((l) => l());
  });
}

export function InstallPrompt() {
  const [canPrompt, setCanPrompt] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [secure, setSecure] = useState(true);
  useEffect(() => {
    setSecure(window.isSecureContext);
    setInstalled(window.matchMedia("(display-mode: standalone)").matches);
    setCanPrompt(Boolean(deferred));
    const l = () => setCanPrompt(Boolean(deferred));
    listeners.add(l);
    const onInstalled = () => setInstalled(true);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      listeners.delete(l);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return <Badge tone="ok">Installed — you’re running the app</Badge>;
  return (
    <div className="space-y-3 text-sm">
      {!secure ? (
        <p className="rounded-xl bg-warn-soft p-3 text-warn">
          Installing requires HTTPS. Open Jarvis at its HTTPS address (for example through Traefik) on your phone.
        </p>
      ) : null}
      {canPrompt ? (
        <Button
          variant="primary"
          onClick={async () => {
            await deferred?.prompt();
            const choice = await deferred?.userChoice;
            if (choice?.outcome === "accepted") setInstalled(true);
            deferred = null;
            setCanPrompt(false);
          }}
        >
          Install Jarvis
        </Button>
      ) : null}
      <div>
        <p className="font-medium">On Android (Chrome)</p>
        <ol className="ml-5 list-decimal text-muted">
          <li>Open Jarvis at its HTTPS address.</li>
          <li>
            Tap the ⋮ menu → <strong>Install app</strong> (or <strong>Add to Home screen</strong>).
          </li>
          <li>Open Jarvis from your home screen, then enable push in Settings → Notifications.</li>
        </ol>
      </div>
      <div>
        <p className="font-medium">On iPhone (Safari)</p>
        <p className="text-muted">Share → Add to Home Screen. Push works only from the installed app.</p>
      </div>
    </div>
  );
}
