"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { ErrorNote, useToast, LoadingState } from "@/components/ui";
import { Button } from "@/components/ui/legacy";

type Status = {
  installed: boolean;
  name: string;
  translation: string;
  version: string;
  pinnedSha256: string;
  sourceUrl: string;
  downloadBytes: number;
  installedAt: string | null;
  verses: number;
};

/** #142 Settings → Connections → Offline Bible: opt-in download of the pinned public-domain WEB pack. */
export function BiblePackSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["bible-status"], queryFn: () => api.get<Status>("/api/bible") });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const s = q.data;
  const run = async (fn: () => Promise<Status>, ok: string) => {
    setBusy(true);
    try {
      qc.setQueryData(["bible-status"], await fn());
      qc.removeQueries({ queryKey: ["bible-passage"] });
      toast(ok, "ok");
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  if (!s) return <LoadingState label="Loading…" />;
  const mb = (s.downloadBytes / 1024 / 1024).toFixed(1);
  return (
    <div className="space-y-2 text-sm" data-testid="bible-pack">
      <p>
        Shows verse text next to Scripture references in workflows, from a copy of the {s.name} ({s.translation}) stored on this Jarvis. Lookups never leave
        Jarvis.
      </p>
      <p className="text-muted">
        The {s.name} is in the public domain; text from eBible.org. &ldquo;World English Bible&rdquo; is a trademark of eBible.org. Other translations stay
        reference-only.
      </p>
      {s.installed ? (
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="bible-installed">
            Downloaded · version {s.version} · {s.verses.toLocaleString()} verses
          </span>
          <Button size="sm" variant="ghost" type="button" busy={busy} onClick={() => void run(() => api.del<Status>("/api/bible"), "Offline Bible removed")}>
            Remove
          </Button>
        </div>
      ) : confirm ? (
        <div className="space-y-2 rounded-lg border border-line p-2.5" role="group" aria-label="Confirm download">
          <p>
            Download {mb} MB once from <span className="break-all">{s.sourceUrl}</span>? Jarvis checks it against the pinned checksum (version {s.version})
            before using it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              type="button"
              busy={busy}
              onClick={() => void run(() => api.post<Status>("/api/bible", { confirm: true }), "Offline Bible ready")}
            >
              Download
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" type="button" onClick={() => setConfirm(true)} data-testid="bible-download">
          Download offline Bible ({mb} MB)
        </Button>
      )}
    </div>
  );
}
