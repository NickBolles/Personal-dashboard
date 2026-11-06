"use client";
import { useEffect, useState, type RefObject } from "react";
import { setPanelOwner } from "@/lib/client/panel-owner";
import type { ThingsTab } from "@/lib/chat/things";

/** Observe the chat container, never the viewport: the coordinator consumes page width. */
export function useChatPanelLayout(sessionId: string, wrapper: RefObject<HTMLDivElement | null>, ready: boolean, workflow = false) {
  const [wide, setWide] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [tab, setTab] = useState<ThingsTab | null>(null);
  useEffect(() => {
    if (!wrapper.current) return;
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 900));
    observer.observe(wrapper.current);
    return () => observer.disconnect();
  }, [ready, wrapper]);
  useEffect(() => {
    if (!wide || collapsed) return;
    setPanelOwner(sessionId);
    return () => setPanelOwner(null);
  }, [wide, collapsed, sessionId]);
  return {
    wide,
    tab: tab ?? (workflow ? "Outline" : "Links"),
    setTab,
    open: wide ? !collapsed : sheet,
    show: (next: ThingsTab) => {
      setTab(next);
      setCollapsed(false);
      setSheet(true);
    },
    close: () => {
      setCollapsed(true);
      setSheet(false);
    },
  };
}
