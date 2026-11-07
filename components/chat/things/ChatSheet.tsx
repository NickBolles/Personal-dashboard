"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/legacy";

/** ContextSheet's bottom-sheet pattern, portalled beyond the chat query container. */
export function ChatSheet({ children, onClose, full, onFull }: { children: ReactNode; onClose: () => void; full: boolean; onFull: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const title = useId();
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      document.body.style.overflow = overflow;
      restore?.focus?.();
    };
  }, []);
  return createPortal(
    <div
      className="chat-panel-sheet fixed inset-0 z-50"
      data-full={full}
      onKeyDown={(e) => {
        // Nested workflow/file dialogs own their keys. Do not dismiss both sheets on Escape.
        if ((e.target as HTMLElement).closest('[role="dialog"]') !== panel.current) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
        if (e.key === "Tab") {
          const items = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          );
          const first = items[0];
          const last = items.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        className="chat-sheet-body safe-bottom absolute inset-x-0 bottom-0 flex max-h-[90dvh] flex-col rounded-t-2xl border border-line bg-surface shadow-xl"
      >
        <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line" />
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1">
          <h2 id={title} className="min-w-0 flex-1 text-sm font-semibold">
            In this chat
          </h2>
          <Button size="sm" variant="ghost" onClick={onFull}>
            {full ? "Half height" : "Full height"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Done
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
