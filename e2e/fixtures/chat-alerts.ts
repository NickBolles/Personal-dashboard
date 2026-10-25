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

/** The Areas pane beside the conversation: a fixed tree, so the snapshot never depends on other specs' data. */
const node = (id: string, parentId: string | null, kind: string, title: string, extra: Record<string, unknown> = {}) => ({
  id,
  parentId,
  kind,
  title,
  summary: "",
  nextAction: "",
  status: "exploring",
  sortOrder: 0,
  startDate: null,
  targetDate: null,
  completedAt: null,
  settledKind: null,
  settledReason: null,
  archived: false,
  builtIn: false,
  validationDefault: null,
  sessionId: null,
  settings: null,
  createdAt: visualNow,
  updatedAt: visualNow,
  ...extra,
});
export const areasVisual = {
  items: [
    node("wk_mb", null, "area", "Momentum Bets", { sortOrder: 0 }),
    node("wk_ce", "wk_mb", "project", "Criteria evaluator", { status: "in_progress" }),
    node("wk_v5", "wk_ce", "thread", "V5 evaluator contract", { status: "awaiting_validation" }),
    node("wk_cv", "wk_v5", "conversation", "Lock the V5 rubric", { sessionId: "sess_rubric" }),
    node("wk_home", null, "area", "Home", { sortOrder: 1 }),
    node("wk_garage", "wk_home", "thread", "Garage cleanup", { status: "planned" }),
    node("wk_misc", null, "area", "Miscellaneous", { builtIn: true, sortOrder: 2 }),
    node("wk_cm", "wk_misc", "conversation", "Dinner ideas", { sessionId: "sess_dinner" }),
  ],
  linkedConversations: [{ itemId: "wk_garage", sessionId: "sess_garage", title: "Shelving options" }],
};
export const inboxVisual = { items: [], conversations: [], conversationsTotal: 0, unavailable: [], count: 2 };
