import type { ComponentName } from "./catalog";

/**
 * What the owner reads on a smart block's header tag. A component's internal name ("DecisionCard",
 * "ApprovalQueue") is for the catalog and the model, never for the screen. `null` = the block's own title says
 * enough, draw no tag. A smart "choice" is not a decision record (D-n), so it is not called one.
 */
const LABELS: Record<ComponentName, string | null> = {
  DecisionMatrix: "Comparison",
  Gantt: "Timeline",
  BarChart: "Chart",
  ApprovalQueue: "Approvals",
  Form: "Form",
  Stack: "Jarvis",
  Section: null,
  Text: null,
  Callout: null,
  Divider: null,
  TaskList: "Tasks",
  DecisionCard: "Choice",
  Checklist: "Checklist",
  Gauge: null,
  Sparkline: null,
  ApprovalChips: "Approval",
  WeekPlan: "Week plan",
  PRCard: "Pull request",
  Table: "Table",
  ItemRef: null,
};

/** The tag for a smart component, or null for none. An unknown type gets no tag rather than its raw name. */
export function smartLabel(type: string | undefined): string | null {
  return type && type in LABELS ? LABELS[type as ComponentName] : null;
}
