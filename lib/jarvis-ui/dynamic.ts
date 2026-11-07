import type { JarvisSpec } from "./catalog";
export type DynamicCard = {
  id: string;
  kind: "weekly-review" | "chores" | "calendar-conflict" | "garage";
  line: { tone: "bad" | "warn" | "ai" | "ok" | "neutral"; dot: "red" | "yellow" | null; icon: string; label: string; text: string };
  spec: JarvisSpec;
  sessionId: string;
  blockIndex: number;
  action: "Fill in" | "Open" | "Review";
  footer?: { label: string; href: string };
  garage?: { entityId: string; closeAllowed: boolean; undoAllowed: boolean };
};
export type DynamicResponse = { cards: DynamicCard[]; today: string };
