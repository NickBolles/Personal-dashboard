"use client";

import { useAccess } from "@/components/access";
import { SessionList } from "@/components/chat/SessionList";
import { AreasSidebar } from "@/components/areas/AreasSidebar";

/** Desktop pane beside conversations: the Areas tree with Areas (work.use), else the plain conversation list. */
export function ChatAside() {
  const { can } = useAccess();
  if (can("work.use"))
    return (
      <div className="work-ui">
        <AreasSidebar />
      </div>
    );
  return (
    <>
      <h2 className="eyebrow mb-2 px-1 pt-1">Conversations</h2>
      <SessionList compact />
    </>
  );
}
