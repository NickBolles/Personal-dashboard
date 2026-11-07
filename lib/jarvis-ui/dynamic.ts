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
  /** Smart garage card: Close and Open (high-risk) are each other’s Undo (owner decision 2026-11-07, #219). */
  garage?: { entityId: string; name?: string; closeAllowed: boolean; openAllowed?: boolean; undoAllowed: boolean };
};
export type DynamicResponse = { cards: DynamicCard[]; today: string };
