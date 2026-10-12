import type { EntityLink, JarvisNotification } from "@/lib/contracts";
import type { SessionSummary, TimelineItem } from "@/lib/hermes";

// Visual-only BFF fixtures: resetting mock providers cannot clear Jarvis-owned
// initiative links or notifications created by earlier interaction specs.
export const visualNow = "2026-10-11T13:15:00.000Z";
export const chatVisual = {
  session: {
    id: "sess_morning",
    title: "Morning planning",
    preview: "What's on my plate today?",
    startedAt: "2026-10-11T11:15:00.000Z",
    lastActiveAt: visualNow,
    messageCount: 4,
    pinned: false,
    archived: false,
    source: "api_server",
    shared: false,
    readOnly: false,
  },
  timeline: [
    { kind: "user", id: "visual-user", text: "What's on my plate today?", at: visualNow },
    { kind: "tool", id: "visual-tool", tool: "web_search", summary: "weather wausau today", detail: "Sunny, high of 64°F", at: visualNow, error: false },
    { kind: "assistant", id: "visual-assistant", text: "You have 3 todos due today and it's sunny — good day for the garage cleanup.", at: visualNow },
  ],
  children: [],
  links: [],
} satisfies { session: SessionSummary; timeline: TimelineItem[]; children: SessionSummary[]; links: EntityLink[] };

export const alertsVisual = {
  notifications: [
    {
      id: "visual-garage",
      type: "home.exception",
      category: "ha_critical",
      severity: "high",
      title: "Garage door: Open for 45 min",
      body: "Current state: open",
      source: "home_assistant",
      deepLink: "/home-control?entity=cover.garage_door",
      occurrences: 1,
      createdAt: visualNow,
      updatedAt: visualNow,
    },
    {
      id: "visual-overdue",
      type: "todos.overdue",
      category: "overdue",
      severity: "normal",
      title: "1 overdue todo",
      body: "Renew car registration",
      source: "todos",
      deepLink: "/todos",
      occurrences: 1,
      createdAt: visualNow,
      updatedAt: visualNow,
    },
    {
      id: "visual-test",
      type: "jarvis.test",
      category: "hermes_input",
      severity: "normal",
      title: "Test notification",
      body: "If you can read this on your phone, push works. Tap to open Alerts.",
      source: "jarvis",
      deepLink: "/alerts",
      occurrences: 1,
      createdAt: visualNow,
      updatedAt: visualNow,
    },
  ],
  unread: 3,
} satisfies { notifications: JarvisNotification[]; unread: number };
