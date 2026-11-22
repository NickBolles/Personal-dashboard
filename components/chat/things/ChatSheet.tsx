"use client";
import type { ReactNode } from "react";
import { Sheet } from "@/components/ui";

/**
 * "In this chat" on phones: the library's bottom sheet (drag the top of it up for full height and down to close;
 * the grab bar is also a button that switches height), portalled beyond the chat query container.
 */
export function ChatSheet({ children, onClose, full, onFull }: { children: ReactNode; onClose: () => void; full: boolean; onFull: (full: boolean) => void }) {
  return (
    <Sheet
      title="In this chat"
      onClose={onClose}
      full={full}
      onFull={onFull}
      closeLabel="Collapse"
      className="chat-panel-sheet"
      bodyClassName="chat-sheet-body"
    >
      {children}
    </Sheet>
  );
}
