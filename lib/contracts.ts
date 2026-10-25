/**
 * Normalized internal models exposed to the UI. Upstream DTOs stay inside
 * their adapter under integrations/<source>/ so external schema changes are
 * contained there.
 */

/** Sources with an integration adapter (fetched, snapshotted, status-reported). */
export type AdapterSource = "hermes" | "paperclip" | "todos" | "skylight" | "daily_compass" | "home_assistant" | "finance";
/** Everything that can put a card on Home: the adapters plus Jarvis' own per-person Work hub. */
export type ActionSource = AdapterSource | "work";

export const ACTION_SOURCES: AdapterSource[] = ["hermes", "paperclip", "todos", "skylight", "daily_compass", "home_assistant", "finance"];
/** Every Home card source, for feedback and tuning (Work is computed per person, not fetched). */
export const HOME_SOURCES: ActionSource[] = [...ACTION_SOURCES, "work"];

export const SOURCE_LABELS: Record<ActionSource, string> = {
  hermes: "Hermes",
  paperclip: "Paperclip",
  todos: "Todos",
  skylight: "Skylight",
  daily_compass: "Daily Compass",
  home_assistant: "Home Assistant",
  finance: "Finance",
  work: "Work",
};

export type PriorityReason = "critical" | "awaiting_user" | "overdue" | "due_soon" | "checkin_window" | "today" | "upcoming";

export const PRIORITY_ORDER: PriorityReason[] = ["critical", "awaiting_user", "overdue", "due_soon", "checkin_window", "today", "upcoming"];

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
  /** Home only: plain-language reasons for its place (server/ranking/attention.ts). */
  why?: string[];
  /** Home only: where the ranking put it, and what feedback refers to. */
  rank?: ActionRank;
};

/** Ranking tiers, highest first (docs/home-priorities.md). */
export type AttentionTier =
  "critical" | "awaiting_user" | "pinned" | "compass" | "overdue_recent" | "due_soon" | "checkin_window" | "today" | "overdue_stale" | "upcoming" | "someday";

export type AttentionBucket = "now" | "today" | "upcoming" | "backlog";

export type ActionRank = {
  tier: AttentionTier;
  bucket: AttentionBucket;
  /** feedback category, e.g. "source:todos" */
  category: string;
  /** changes when the item's due date or title changes (feedback provenance) */
  fingerprint: string;
};

export type AttentionSummary = {
  version: number;
  budget: { now: number; today: number; upcoming: number };
  /** counted after scoping, dedupe and snoozes; now + today + upcoming + backlog = open */
  totals: { open: number; now: number; today: number; upcoming: number; backlog: number; overdue: number; snoozed: number; waiting: number };
  /** critical items shown in Now beyond its budget (never hidden) */
  overBudget: number;
  /** Today's Daily Compass focus, only for people who use it. Never invented. */
  compass?: {
    state: "focus" | "no_focus" | "outdated" | "unavailable";
    focus: string[];
    asOf?: string;
    stale?: boolean;
  };
};

export type AssistKind = "overdue_triage" | "plan_ahead" | "seasonal";

/**
 * A deterministic suggestion built from data Jarvis already has (or a dated
 * season). AI only comes in when the person opens the chat and sends.
 */
export type AssistCard = {
  /** stable id; also the snooze key ("assist:…") */
  id: string;
  kind: AssistKind;
  category: string;
  title: string;
  body: string;
  /** where this came from, in words ("From your Todos", "Seasonal idea, not from your calendar") */
  basis: string;
  origin: "data" | "milestone" | "calendar" | "seasonal";
  tone: "warn" | "accent" | "neutral";
  why: string[];
  provenance: { version: number; fingerprint: string; sources: string[]; generatedAt: string };
  /** reschedulable todos (with snooze, when the person may edit); `due` is the local date */
  triage?: { actionIds: string[]; items: { id: string; title: string; due: string }[] };
  /** opt-in Hermes chat: prefilled draft + bounded context the person reviews before sending */
  chat?: { label: string; draft: string; context: string };
};

export type SourceState = "ok" | "stale" | "error" | "unauthorized" | "disabled" | "unconfigured" | "refreshing";

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

/**
 * Counts only: no entity IDs or names. A count Jarvis could not read is
 * undefined and renders as "unknown", never 0.
 */
export type HomeHealth = {
  checkedAt: string;
  entities: number;
  unavailable: number;
  unknown: number;
  /** update.* entities reporting "on"; undefined when HA exposes no update entities */
  updatesPending?: number;
  /** config entries not loaded (setup error/retry, not loaded); undefined when the token can't read them */
  integrationsFailing?: number;
  /** integration domains (not entity IDs) that failed to load, max 5 */
  failingDomains?: string[];
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
  /** absent in snapshots saved by older versions */
  attention?: AttentionSummary;
  assists?: AssistCard[];
};

/** GET /api/home/items: one bucket, ranked, paged. */
export type HomeItemsPage = { bucket: AttentionBucket; items: NextAction[]; total: number; offset: number; nextOffset?: number };

/** Home sections the user can reorder or hide (phone app and web share this layout). */
export const HOME_SECTIONS = [
  { id: "now", label: "Now" },
  { id: "glance", label: "Household glance" },
  { id: "later_today", label: "Later today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "waiting", label: "Waiting on" },
  { id: "completed", label: "Recently completed" },
] as const;
export type HomeSectionId = (typeof HOME_SECTIONS)[number]["id"];

/** Compact summary for home-screen widgets (GET /api/widget/summary). */
export type WidgetSummary = {
  generatedAt: string;
  unread: number;
  next: Pick<NextAction, "id" | "source" | "title" | "detail" | "priorityReason" | "dueAt" | "dueIsDate" | "primaryAction" | "secondaryActions" | "href">[];
  nextEvent?: Pick<CalendarEvent, "title" | "startsAt" | "endsAt" | "allDay" | "location" | "source">;
  compass?: HouseholdGlance["compass"];
  home: { exceptions: Pick<HomeException, "name" | "reason" | "severity" | "state">[]; critical: number };
  degradedSources: string[];
};

export type NotificationSeverity = "info" | "normal" | "high" | "critical";

export type NotificationCategory =
  "hermes_input" | "hermes_complete" | "ha_critical" | "overdue" | "daily_compass" | "finance" | "integration_failure" | "ai_report" | "info";

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
    id: "ai_report",
    label: "AI report ready",
    description: "A background report or investigation finished.",
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
    id: "finance",
    label: "Finance check-in",
    description: "Ready, needs attention, or refresh failed. Never includes amounts or account names. Off until you turn it on.",
    defaultPush: false,
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

export type EntityLinkRelationship = "originated_from" | "related_to" | "implements" | "blocked_by" | "evidence_for";

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
