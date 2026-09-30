import { SessionList } from "@/components/chat/SessionList";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="lg:flex">
      <aside aria-label="Conversations" className="hidden w-80 shrink-0 border-r border-line p-4 lg:block lg:h-dvh lg:overflow-y-auto">
        <h2 className="mb-3 text-lg font-semibold">Hermes</h2>
        <SessionList compact />
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
