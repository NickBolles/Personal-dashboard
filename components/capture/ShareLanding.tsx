"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Spinner } from "@/components/ui";
import { useAccess } from "@/components/access";
import { CaptureSheet } from "./CaptureSheet";
import { deleteStaged, readStaged, type StagedShare } from "@/lib/client/capture-queue";

/**
 * POST share target landing (spec §8.8): the service worker staged the shared
 * title/text/url/files in IndexedDB and redirected here with ?staged=<id>.
 * Save to Inbox is primary; Ask Hermes is the alternative (text only).
 */
export function ShareLanding({ staged, error }: { staged?: string; error?: string }) {
  const router = useRouter();
  const canChat = useAccess().can("hermes.chat");
  const [share, setShare] = useState<StagedShare | null | undefined>(staged ? undefined : null);
  useEffect(() => {
    if (!staged) return;
    let live = true;
    readStaged(staged)
      .then((s) => live && setShare(s))
      .catch(() => live && setShare(null));
    return () => {
      live = false;
    };
  }, [staged]);
  const [round, setRound] = useState(0);
  const done = (r?: { queued: boolean }) => {
    if (staged) void deleteStaged(staged).catch(() => undefined);
    // Queued offline: stay here with a fresh sheet. Navigating offline turns into a full
    // reload from the page cache, which would drop the "Saved on this phone" toast.
    if (r?.queued && !staged) {
      setRound((n) => n + 1);
      return;
    }
    // Launched by a share: go back to the app that shared; otherwise to the Inbox.
    if (staged && window.history.length > 2) window.history.back();
    else router.push("/inbox");
  };
  return (
    <div className="mx-auto max-w-xl p-3 sm:p-6">
      <Card>
        <h1 className="mb-2 text-lg font-semibold">{staged || error ? "Save to Inbox" : "Capture"}</h1>
        {error === "sw" ? (
          <p role="alert" className="mb-2 text-[13px] text-danger">
            Couldn&apos;t receive the share. Open Jarvis once and try again.
          </p>
        ) : null}
        {share === undefined ? (
          <Spinner label="Loading what you shared…" />
        ) : (
          <>
            {share?.rejected?.length ? <p className="mb-2 text-[13px] text-muted">Skipped (unsupported or over 10 MB): {share.rejected.join(", ")}</p> : null}
            <CaptureSheet
              key={round}
              autoFocus
              channel={share ? "pwa_share" : "web"}
              initial={share ? { title: share.title, text: share.text, url: share.url, files: share.files } : undefined}
              askable={canChat}
              onDone={done}
            />
          </>
        )}
      </Card>
    </div>
  );
}
