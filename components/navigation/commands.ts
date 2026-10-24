"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useAccess } from "@/components/access";
import { useToast } from "@/components/ui";

/**
 * Commands shared by the command palette (SearchDialog) and the command dock's
 * radial action map: every dock action is also a palette command, so the
 * gesture is a shortcut, never the only way. Work commands need `work.use`
 * (and conversation ones `hermes.chat`); the server checks again.
 */
export type Command = {
  id: string;
  label: string;
  group: "Go to" | "Work" | "Search";
  keywords: string;
  run: () => void;
};

/** Open the global search/command palette from anywhere. */
export const OPEN_PALETTE_EVENT = "jarvis:search";
/** Open the quick-capture dialog (Work inbox). */
export const OPEN_CAPTURE_EVENT = "jarvis:work-capture";

/** The Work item open in /work right now, if any. */
function currentWorkItem() {
  if (typeof window === "undefined" || window.location.pathname !== "/work") return null;
  return new URLSearchParams(window.location.search).get("item");
}

export function useCommands(): Command[] {
  const router = useRouter();
  const { can } = useAccess();
  const { toast } = useToast();
  const work = can("work.use");
  const chat = can("hermes.chat");
  return useMemo(() => {
    const go = (href: string) => () => router.push(href);
    const onItem = (action: string, fallback: string) => () => {
      const id = currentWorkItem();
      if (id) router.push(`/work?item=${encodeURIComponent(id)}&do=${action}`);
      else {
        router.push("/work");
        toast(fallback, "neutral");
      }
    };
    const list: (Command | false)[] = [
      { id: "search", label: "Search everything", group: "Search", keywords: "find look up", run: () => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT)) },
      { id: "go.home", label: "Go to Home", group: "Go to", keywords: "home start", run: go("/home") },
      chat && { id: "go.chat", label: "Go to Hermes", group: "Go to", keywords: "chat conversations hermes", run: go("/chat") },
      { id: "go.alerts", label: "Go to Alerts", group: "Go to", keywords: "notifications alerts", run: go("/alerts") },
      work && { id: "work.today", label: "Go to Today", group: "Go to", keywords: "work today continue", run: go("/work") },
      work && { id: "work.inbox", label: "Go to Inbox", group: "Go to", keywords: "work inbox triage unfiled issues", run: go("/work?view=inbox") },
      work && { id: "work.timeline", label: "Go to Timeline", group: "Go to", keywords: "work timeline gantt dates", run: go("/work/timeline") },
      work && { id: "work.dashboard", label: "Go to Dashboard", group: "Go to", keywords: "work dashboard widgets lanes", run: go("/work/dashboard") },
      work && { id: "work.map", label: "Go to Map", group: "Go to", keywords: "work map graph", run: go("/work/map") },
      work && {
        id: "work.capture",
        label: "Capture to Inbox",
        group: "Work",
        keywords: "capture note inbox add quick",
        run: () => window.dispatchEvent(new Event(OPEN_CAPTURE_EVENT)),
      },
      work && {
        id: "work.packet",
        label: "Start focused work",
        group: "Work",
        keywords: "focus packet handoff start",
        run: onItem("packet", "Pick an item first, then start focused work."),
      },
      work && {
        id: "work.validate",
        label: "Record validation",
        group: "Work",
        keywords: "validate validation result proof measure",
        run: onItem("validate", "Proof due is listed on Today."),
      },
      work &&
        chat && {
          id: "work.continue",
          label: "Continue in conversation",
          group: "Work",
          keywords: "continue conversation handoff hermes claude",
          run: onItem("continue", "Pick an item first, then continue it in a new conversation."),
        },
    ];
    return list.filter((c): c is Command => !!c);
  }, [router, work, chat, toast]);
}

/** Commands whose label or keywords contain every word of `q`. Empty query → all of them. */
export function matchCommands(commands: Command[], q: string) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return commands;
  return commands.filter((c) => {
    const hay = `${c.label} ${c.keywords} ${c.group}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
