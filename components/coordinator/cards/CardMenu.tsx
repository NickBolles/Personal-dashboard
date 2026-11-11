"use client";

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { Menu, type KMenuItem } from "@/components/ui";

/** Width the menu is laid out at (run-card.css), used to keep it inside the card. */
const MENU_WIDTH = 216;

/**
 * Every action of a card in one menu, opened where the card is right-clicked or long-pressed (Android fires
 * `contextmenu` for a long press; the keyboard's Menu key and Shift+F10 fire it on the focused header). It is an
 * accelerator: the same actions are in the card itself once it is open. Links, fields and the menu itself keep
 * the browser's own menu.
 */
export function useCardMenu(enabled = true) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!enabled || (event.target as HTMLElement).closest("a, input, textarea, [role='menu']")) return;
    event.preventDefault();
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    // A keyboard-opened menu reports no pointer position: open it under the card's top-left corner.
    const keyboard = event.clientX === 0 && event.clientY === 0;
    const x = keyboard ? 12 : event.clientX - box.left;
    const y = keyboard ? 36 : event.clientY - box.top;
    setAt({ x: Math.max(8, Math.min(x, box.width - MENU_WIDTH - 8)), y: Math.max(8, y) });
  };
  return { at, onContextMenu, close: () => setAt(null) };
}

export function CardMenu({
  at,
  label,
  items,
  onClose,
  className = "rc-menu",
}: {
  at: { x: number; y: number } | null;
  label: string;
  items: KMenuItem[];
  onClose: () => void;
  /** Where it sits: on a card by default (run-card.css), or a place of the caller's own. */
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const open = !!at;
  useEffect(() => {
    if (!open) return;
    // Near the bottom of a scrolling panel the menu would be cut off: bring it into view.
    box.current?.scrollIntoView?.({ block: "nearest" });
    const dismiss = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [open, onClose]);
  if (!at) return null;
  return (
    <div ref={box} className={className} style={{ "--x": `${at.x}px`, "--y": `${at.y}px` } as CSSProperties}>
      <Menu label={label} items={items} onClose={onClose} />
    </div>
  );
}
