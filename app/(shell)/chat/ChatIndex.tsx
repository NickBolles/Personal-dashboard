"use client";

import { useEffect } from "react";
import { QuickCapture } from "@/components/chat/QuickCapture";
import { SessionList } from "@/components/chat/SessionList";
import { kvSet } from "@/lib/client/idb";
import { PageHeader } from "@/components/ui";

export function ChatIndex({ startNew, context, draft }: { startNew?: boolean; context?: string; draft?: string }) {
  useEffect(() => {
    if (draft) kvSet("draft:quick", draft);
  }, [draft]);
  return (
    <div className="mx-auto max-w-3xl px-4 py-5 sm:px-6">
      <PageHeader title="Hermes" subtitle="Start something new or pick up a conversation." />
      <div className="mb-6">
        {context ? (
          <div className="mb-2 rounded-xl border border-line bg-surface-2 p-3 text-sm">
            <p className="text-xs font-medium text-muted">Attached context</p>
            <p className="mt-0.5">{context}</p>
          </div>
        ) : null}
        <QuickCapture key={draft ?? "q"} context={context} placeholder={startNew || context ? "What should Hermes do with this?" : undefined} />
      </div>
      <div className="lg:hidden">
        <SessionList />
      </div>
      <p className="hidden text-sm text-muted lg:block">Choose a conversation on the left, or start one above.</p>
    </div>
  );
}
