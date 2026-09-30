/**
 * Normalized internal models exposed to the UI. Upstream DTOs stay inside
 * their adapter under integrations/<source>/ so external schema changes are
 * contained there.
 */

export type ActionSource =
  | "hermes"
  | "paperclip"
  | "todos"
  | "skylight"
  | "daily_compass"
  | "home_assistant";

export const ACTION_SOURCES: ActionSource[] = [
  "hermes",
  "paperclip",
  "todos",
  "skylight",
  "daily_compass",
  "home_assistant",
];

export const SOURCE_LABELS: Record<ActionSource, string> = {
  hermes: "Hermes",
  paperclip: "Paperclip",
  todos: "Todos",
  skylight: "Skylight",
  daily_compass: "Daily Compass",
  home_assistant: "Home Assistant",
};

export type PriorityReason =
  | "critical"
  | "awaiting_user"
  | "overdue"
  | "due_soon"
  | "checkin_window"
  | "today"
  | "upcoming";

export const PRIORITY_ORDER: PriorityReason[] = [
  "critical",
  "awaiting_user",
  "overdue",
  "due_soon",
  "checkin_window",
  "today",
  "upcoming",
];

export const PRIORITY_LABELS: Record<PriorityReason, string> = {
  critical: "Needs attention now",
  awaiting_user: "Waiting on you",
  overdue: "Overdue",
  due_soon: "Due soon",
  checkin_window: "Check-in window open",
  today: "Due today",
  upcoming: "Upcoming",
};

export type PrimaryActionKind = "open" | "complete" | "acknowledge" | "snooze";

export type NextAction = {
  id: string;
  source: ActionSource;
  sourceId: string;
  title: string;
  detail?: string;
  status: "open" | "waiting" | "completed" | "dismissed";
  priorityReason: PriorityReason;
  dueAt?: string;
  /** true when the source only knows a due date (no time) */
  dueIsDate?: boolean;
  availableAt?: string;
  updatedAt: string;
  fetchedAt: string;
  staleAfter: string;
  href: string;
  /** true when href points outside Jarvis (deep link into the source system) */
  external?: boolean;
  pinned?: boolean;
  primaryAction?: {
    kind: PrimaryActionKind;
    label: string;
  };
  /** Supported secondary actions (all have visible menu equivalents). */
  secondaryActions?: PrimaryActionKind[];
};

export type SourceState =
  | "ok"
  | "stale"
  | "error"
  | "unauthorized"
  | "disabled"
  | "unconfigured"
  | "refreshing";

export type SourceStatus = {
  source: ActionSource;
  label: string;
  state: SourceState;
  fetchedAt?: string;
  staleAfter?: string;
  error?: string;
  /** true when the data shown came from the last-known snapshot */
  fromCache?: boolean;
};

export type CalendarEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  allDay?: boolean;
  location?: string;
  calendar?: string;
  source: ActionSource;
  href?: string;
};

export type HouseholdGlance = {
  nextEvent?: CalendarEvent;
  compass?: { date: string; completed: boolean; inWindow: boolean; windowLabel: string };
  homeExceptions: HomeException[];
};

export type HomeException = {
  entityId: string;
  name: string;
  state: string;
  severity: "info" | "normal" | "high" | "critical";
  reason: string;
  since?: string;
};

export type HomePayload = {
  generatedAt: string;
  now: NextAction[];
  later: {
    laterToday: NextAction[];
    upcoming: NextAction[];
    waitingOn: NextAction[];
    recentlyCompleted: NextAction[];
  };
  glance: HouseholdGlance;
  sources: SourceStatus[];
};

export type NotificationSeverity = "info" | "normal" | "high" | "critical";

export type NotificationCategory =
  | "hermes_input"
  | "hermes_complete"
  | "ha_critical"
  | "overdue"
  | "daily_compass"
  | "integration_failure"
  | "info";

export const NOTIFICATION_CATEGORIES: {
  id: NotificationCategory;
  label: string;
  description: string;
  defaultPush: boolean;
  bypassQuietHours: boolean;
}[] = [
  {
    id: "hermes_input",
    label: "Hermes needs your input",
    description: "Approvals and questions from a running Hermes task.",
    defaultPush: true,
    bypassQuietHours: false,
  },
  {
    id: "hermes_complete",
    label: "Hermes background work finished",
    description: "A run you started finished while you were away.",
    defaultPush: true,
    bypassQuietHours: false,
  },
  {
    id: "ha_critical",
    label: "Home critical conditions",
    description: "Alarm triggered, door or garage left open, and similar.",
    defaultPush: true,
    bypassQuietHours: true,
  },
  {
    id: "overdue",
    label: "Overdue high-priority actions",
    description: "Todos that slipped past their due time.",
    defaultPush: true,
    bypassQuietHours: false,
  },
  {
    id: "daily_compass",
    label: "Daily Compass reminder",
    description: "A nudge when your check-in window opens.",
    defaultPush: true,
    bypassQuietHours: false,
  },
  {
    id: "integration_failure",
    label: "Integration problems",
    description: "A source has been failing for a sustained period.",
    defaultPush: false,
    bypassQuietHours: false,
  },
  {
    id: "info",
    label: "Informational",
    description: "History and low-importance updates. In-app only by default.",
    defaultPush: false,
    bypassQuietHours: false,
  },
];

export type JarvisNotification = {
  id: string;
  type: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  readAt?: string;
  dismissedAt?: string;
  actedAt?: string;
  dedupeKey?: string;
  occurrences: number;
  deepLink: string;
  source: ActionSource | "jarvis";
};

export type EntityLinkRelationship =
  | "originated_from"
  | "related_to"
  | "implements"
  | "blocked_by"
  | "evidence_for";

export type EntityLink = {
  id: string;
  sourceType: "hermes_session" | "todo" | "calendar_item" | "daily_compass_entry";
  sourceId: string;
  targetSystem: "paperclip";
  targetType: "issue" | "project";
  targetId: string;
  targetIdentifier: string;
  targetTitle?: string;
  relationship: EntityLinkRelationship;
  createdAt: string;
  createdBy: "user" | "agent";
  lastVerifiedAt: string;
};

export type ApiError = { error: string; code?: string; detail?: unknown };
