import { ChatAside } from "./ChatAside";
import "@/components/work/work.css";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="lg:flex">
      <aside
        aria-label="Conversations"
        className="hidden w-72 shrink-0 border-r border-line bg-surface-2 p-2.5 lg:sticky lg:top-0 lg:block lg:h-dvh lg:overflow-y-auto"
      >
        <ChatAside />
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
