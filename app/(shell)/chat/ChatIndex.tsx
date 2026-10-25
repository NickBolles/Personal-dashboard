"use client";

import { QuickCapture } from "@/components/chat/QuickCapture";
import { SessionList } from "@/components/chat/SessionList";
import { BackendSwitch } from "@/components/chat/backend";
import { ConversationsView } from "@/components/areas/ConversationsView";
import { useAccess } from "@/components/access";
import { Kbd, Page, PageHeader } from "@/components/ui";

/** /chat: with Areas, the conversations view of the tree (All / Unfiled); otherwise the plain Hermes list. */
export function ChatIndex({ startNew, context, draft, view }: { startNew?: boolean; context?: string; draft?: string; view?: string }) {
  const { can } = useAccess();
  if (can("work.use")) return <ConversationsView startNew={startNew} context={context} draft={draft} initialFilter={view === "unfiled" ? "unfiled" : "all"} />;
  return (
    <Page width="narrow">
      <PageHeader title="Hermes" subtitle="Start something new or pick up a conversation." actions={<BackendSwitch />} />
      <div className="mb-5">
        {context ? (
          <div className="mb-2 rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-sm">
            <p className="eyebrow">Attached context</p>
            <p className="mt-0.5">{context}</p>
          </div>
        ) : null}
        <QuickCapture
          key={draft ?? "q"}
          mode="ask"
          initialText={draft}
          context={context}
          placeholder={startNew || context ? "What should Hermes do with this?" : undefined}
        />
      </div>
      <div className="lg:hidden">
        <SessionList />
      </div>
      <p className="hidden text-sm text-muted lg:block">
        Choose a conversation on the left, or start one above. <Kbd>Enter</Kbd> sends, <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> adds a line.
      </p>
    </Page>
  );
}
