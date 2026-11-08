"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { Button, ErrorNote, useToast, LoadingState } from "@/components/ui";

type DriveStatus = { available: boolean; configured: boolean; connected: boolean; connectedAt: string | null; scope: string; redirectPath: string };

/** #141 Settings → Connections → Google Drive: separate consent (drive.file only) + disconnect. */
export function DriveConnection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ["drive-status"], queryFn: () => api.get<DriveStatus>("/api/integrations/drive"), retry: false });
  const [busy, setBusy] = useState(false);
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const result = params?.get("drive");
  const message = params?.get("message");
  const s = q.data;
  const disconnect = async () => {
    setBusy(true);
    try {
      const r = await api.del<DriveStatus & { keptSharedGrant?: boolean }>("/api/integrations/drive");
      qc.setQueryData(["drive-status"], r);
      toast(
        r.keptSharedGrant
          ? "Google Drive disconnected. Google access stays on because Google Tasks shares it; remove Jarvis in your Google account to revoke both."
          : "Google Drive disconnected",
        "ok",
      );
    } catch (e) {
      toast((e as Error).message, "danger");
    } finally {
      setBusy(false);
    }
  };
  if (q.error) return <ErrorNote error={q.error} retry={() => q.refetch()} />;
  if (!s) return <LoadingState label="Loading…" />;
  return (
    <div className="space-y-2 text-sm" data-testid="drive-connection">
      <p>
        Saves finished workflow notes (e.g. Teaching notes) as Google Docs in <span className="font-semibold">Teaching notes/&lt;year&gt;</span>. Every save
        asks first and shows the folder.
      </p>
      <p className="text-muted">
        Access: only files Jarvis creates (<code className="break-all">drive.file</code>). Jarvis can&apos;t read or change anything else in your Drive. This is
        a separate permission from any other Google access.
      </p>
      {result === "error" && message ? <ErrorNote error={message} /> : null}
      {!s.available ? (
        <p className="text-muted" data-testid="drive-off">
          Not turned on for this Jarvis. The owner enables it on the server once the Google OAuth client allows the redirect{" "}
          <code className="break-all">{s.redirectPath}</code> and the Google Drive API.
        </p>
      ) : !s.configured ? (
        <p className="text-muted">No Google OAuth client is configured (Connections → Todos, or GOOGLE_CLIENT_ID/SECRET on the server).</p>
      ) : s.connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="drive-connected">Connected{s.connectedAt ? ` · ${new Date(s.connectedAt).toLocaleDateString()}` : ""}</span>
          <Button size="sm" variant="ghost" type="button" loading={busy} onClick={() => void disconnect()}>
            Disconnect Drive
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="primary"
          type="button"
          // full navigation: the API route redirects to Google's consent page (not a Next page)
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          onClick={() => window.location.assign("/api/integrations/drive/oauth/start")}
          data-testid="drive-connect"
        >
          Connect Google Drive
        </Button>
      )}
    </div>
  );
}
