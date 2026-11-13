"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button, SheetHandle, useSheetDrag } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";

/** The sheet's two resting heights in px. Keep in step with `.chat-sheet-body` in things.css. */
const sheetHeights = () => ({ half: Math.min(window.innerHeight * 0.6, 560), full: window.innerHeight * 0.9 });

/**
 * ContextSheet's bottom-sheet pattern, portalled beyond the chat query container.
 * Drag the top of it up for full height and down to close; the grab bar is also a button that switches height.
 */
export function ChatSheet({ children, onClose, full, onFull }: { children: ReactNode; onClose: () => void; full: boolean; onFull: (full: boolean) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const title = useId();
  const { zoneProps, handleProps } = useSheetDrag({ panel, full, onFull, onClose, heights: sheetHeights });
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
        className="chat-sheet-body safe-bottom absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl border border-line bg-surface shadow-xl"
      >
        <div {...zoneProps} className="shrink-0 border-b border-line">
          <SheetHandle {...handleProps} />
          <header className="flex items-center gap-2 pr-1 pb-1 pl-3">
            <h2 id={title} className="min-w-0 flex-1 text-sm font-semibold">
              In this chat
            </h2>
            <Button data-sheet-nodrag size="sm" variant="ghost" iconOnly icon={<ChevronIcon className="h-4 w-4 rotate-90" />} onClick={onClose}>
              Collapse
            </Button>
          </header>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
