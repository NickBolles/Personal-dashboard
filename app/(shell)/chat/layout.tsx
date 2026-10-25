import { SessionList } from "@/components/chat/SessionList";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="lg:flex">
      <aside
        aria-label="Conversations"
        className="hidden w-72 shrink-0 border-r border-line bg-surface p-3 lg:sticky lg:top-0 lg:block lg:h-dvh lg:overflow-y-auto"
      >
        <h2 className="eyebrow mb-2 px-1 pt-1">Conversations</h2>
        <SessionList compact />
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
