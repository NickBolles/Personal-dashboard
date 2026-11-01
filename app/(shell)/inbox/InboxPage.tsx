"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { useAccess } from "@/components/access";
import { AreasNav, WorkShell } from "@/components/work/common";
import { useInbox } from "@/components/work/today";
import { CaptureDialog, InboxView } from "@/components/work/inbox";
import type { WorkItem } from "@/lib/work";

type ItemsResponse = { items: WorkItem[] };

/** The Inbox as its own view: two-pane triage (list + preview) with keyboard keys, bulk accept and a focus mode. */
export function InboxPage({ initialCapture, initialEntry, initialFocus }: { initialCapture?: string; initialEntry?: string; initialFocus?: boolean }) {
  const router = useRouter();
  const canChat = useAccess().can("hermes.chat");
  const items = useQuery({ queryKey: ["work", "items", false], queryFn: () => api.get<ItemsResponse>("/api/work/items") });
  const inbox = useInbox();
  const [capturing, setCapturing] = useState<string | null>(initialCapture ?? null);
  const list = items.data?.items ?? [];
  const open = (id: string) => {
    const it = list.find((i) => i.id === id);
    if (it?.kind === "conversation" && it.sessionId && canChat) router.push(`/chat/${encodeURIComponent(it.sessionId)}`);
    else router.push(`/areas?item=${encodeURIComponent(id)}`);
  };
  return (
    <WorkShell>
      <div className="mx-auto w-full max-w-6xl space-y-3 px-3 py-3 sm:px-4">
        <AreasNav current="inbox" inboxCount={inbox.data?.count} className="px-1" />
        <InboxView items={list} onOpenItem={open} initialEntry={initialEntry} initialFocus={initialFocus} />
      </div>
      {capturing != null ? <CaptureDialog initialText={capturing || undefined} onClose={() => setCapturing(null)} /> : null}
    </WorkShell>
  );
}
