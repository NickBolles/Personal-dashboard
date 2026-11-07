import type { Feedback, FeedbackList } from "../../lib/feedback";

const at = "2026-11-07T14:05:00.000Z";
const base: Feedback = {
  id: "fb_visual_1",
  sessionId: "sess_morning",
  messageId: "msg_visual_1",
  surface: "chat",
  rating: "down",
  reasons: ["wrong"],
  note: "Pickup moved to Wednesday this week (holiday).",
  excerpt: "Your next garbage pickup is Thursday morning. Put the bins out the night before.",
  profile: "default",
  areaId: "wk_visual_home",
  areaTitle: "Home",
  model: "gpt-6.1-sol",
  tools: ["skylight_read"],
  status: "new",
  fixRequestedAt: at,
  itemId: null,
  itemTitle: null,
  triagedAt: null,
  createdAt: at,
  updatedAt: at,
};

/** Fixed inbox data for visual/a11y tests (stub every /api/feedback list). */
export function feedbackVisual(): FeedbackList {
  return {
    entries: [
      base,
      {
        ...base,
        id: "fb_visual_2",
        messageId: "msg_visual_2",
        surface: "coordinator",
        reasons: ["too_long", "ugly_ui"],
        note: "",
        excerpt: "Here is a full breakdown of every project in the portfolio, grouped by area, with status and next action for each one.",
        profile: "chiefofstaff",
        areaId: "wk_visual_portfolio",
        areaTitle: "Portfolio",
        status: "triaged",
        fixRequestedAt: null,
        itemId: "wk_visual_item",
        itemTitle: "Feedback: Too long",
        triagedAt: at,
      },
      {
        ...base,
        id: "fb_visual_3",
        messageId: "msg_visual_3",
        surface: "card",
        reasons: ["didnt_do_it"],
        note: "Never filed the chore.",
        excerpt: "Chores: 3 due today",
        status: "wont_fix",
        fixRequestedAt: null,
        triagedAt: at,
      },
    ],
    counts: { total: 5, down: 3, newDown: 1 },
    profiles: ["chiefofstaff", "default"],
    areas: [
      { id: "wk_visual_home", title: "Home" },
      { id: "wk_visual_portfolio", title: "Portfolio" },
    ],
  };
}
