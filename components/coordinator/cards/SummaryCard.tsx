"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { AnchoredMenu, MenuButton, useAnchoredMenu, type KMenuItem } from "@/components/ui";
import "../running/run-card.css";

type DataAttrs = { [key: `data-${string}`]: string | boolean | undefined };

/**
 * The one card shell every coordinator summary card uses (run cards, background-work cards, item/project cards):
 * the `.rc` surface, its state attributes, and "every action of this card" as a kit anchored menu — a visible ⋯
 * trigger plus right-click, long press and the Menu key on the card, with focus returning to the opener on close.
 * Cards differ only in what they render inside and which actions they list.
 *
 * `menuEnabled: false` (nothing worth a menu) drops the ⋯ trigger and keeps the browser's own context menu.
 */
export function SummaryCard({
  label,
  actions,
  menuEnabled = true,
  className,
  children,
  ...rest
}: {
  /** What the card is, for the menu and its trigger: "Actions for <label>". */
  label: string;
  actions: KMenuItem[];
  menuEnabled?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "children" | "className"> &
  DataAttrs) {
  const menu = useAnchoredMenu({ enabled: menuEnabled });
  const name = `Actions for ${label}`;
  return (
    <article className={["rc", className].filter(Boolean).join(" ")} {...rest} {...menu.surfaceProps}>
      <AnchoredMenu menu={menu} label={name} items={actions} />
      <MenuButton menu={menu} label={name} className="rc-menu-btn" />
      {children}
    </article>
  );
}
