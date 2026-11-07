"use client";

import "./areas.css";

import type { KeyboardEvent, MouseEvent } from "react";
import { cx } from "@/components/ui";
import { AREA_TAB_LABELS, AREA_TABS, areasHref, type AreaTab } from "@/lib/areas-view";

/** id of the tab panel the tabs control (WorkView renders it). */
export const AREA_PANEL_ID = "areas-tabpanel";

/**
 * Areas v2 view tabs: Overview · (Chats) · Board · Activity · Graph. Each tab is a real
 * link (new tab, bookmarks) but a plain click swaps the pane in place: the
 * selected node (`?item=`) and the page scroll stay where they are.
 * Arrow keys / Home / End move between tabs (WAI-ARIA tabs pattern, automatic activation).
 */
export function AreaTabs({
  tab,
  item,
  leaf = false,
  onTab,
  className,
}: {
  tab: AreaTab;
  item: string | null;
  /** a work item (not an area/project): its Chats section joins the bar */
  leaf?: boolean;
  onTab: (t: AreaTab) => void;
  className?: string;
}) {
  const tabs = AREA_TABS.filter((t) => t !== "chats" || leaf);
  const href = (t: AreaTab) => areasHref(item ? `/areas?item=${encodeURIComponent(item)}` : "/areas", { tab: t });
  const pick = (e: MouseEvent, t: AreaTab) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onTab(t);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.indexOf(tab);
    const n =
      e.key === "ArrowRight"
        ? (i + 1) % tabs.length
        : e.key === "ArrowLeft"
          ? (i - 1 + tabs.length) % tabs.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? tabs.length - 1
              : -1;
    if (n < 0) return;
    e.preventDefault();
    onTab(tabs[n]);
    requestAnimationFrame(() => document.getElementById(`areas-tab-${tabs[n]}`)?.focus());
  };
  return (
    <div role="tablist" aria-label="Views" className={cx("ar-tabs", className)} onKeyDown={onKey} data-testid="area-tabs">
      {tabs.map((t) => (
        <a
          key={t}
          id={`areas-tab-${t}`}
          href={href(t)}
          role="tab"
          aria-selected={t === tab}
          aria-controls={AREA_PANEL_ID}
          tabIndex={t === tab ? 0 : -1}
          className="ar-tab"
          onClick={(e) => pick(e, t)}
        >
          {AREA_TAB_LABELS[t]}
        </a>
      ))}
    </div>
  );
}
