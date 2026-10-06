import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Jarvis-owned persistence only. Hermes sessions/messages, Paperclip issues and
 * other source records stay in their source systems; we keep links, caches,
 * preferences, notification state and audit records.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** sign-in name (lowercase); null for the original owner until they set one */
  username: text("username").unique(),
  /** admin | adult | kid | household (lib/modules.ts) */
  role: text("role").notNull().default("admin"),
  passcodeHash: text("passcode_hash"),
  disabledAt: text("disabled_at"),
  createdAt: text("created_at").notNull().default(now),
});

/** Per-person capability grants/revocations on top of their role's defaults. */
export const userCapabilities = sqliteTable(
  "user_capabilities",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
    granted: integer("granted", { mode: "boolean" }).notNull(),
  },
  (t) => [uniqueIndex("user_capabilities_idx").on(t.userId, t.capability)],
);

/** One-time invites to join the household (hashed code, expires). */
export const invites = sqliteTable("invites", {
  codeHash: text("code_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    /** sha256 of the opaque cookie token */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(now),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull().default(now),
    userAgent: text("user_agent"),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

/** Key/value preferences. Values are JSON. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(now),
});

/** Integration connection metadata. Secrets are AES-256-GCM encrypted. */
export const integrations = sqliteTable("integrations", {
  kind: text("kind").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  config: text("config").notNull().default("{}"),
  secrets: text("secrets"),
  lastTestAt: text("last_test_at"),
  lastTestOk: integer("last_test_ok", { mode: "boolean" }),
  lastTestResult: text("last_test_result"),
  updatedAt: text("updated_at").notNull().default(now),
});

/** Last-known normalized source summaries with freshness metadata. */
export const sourceSnapshots = sqliteTable("source_snapshots", {
  source: text("source").primaryKey(),
  state: text("state").notNull(),
  fetchedAt: text("fetched_at"),
  staleAfter: text("stale_after"),
  error: text("error"),
  payload: text("payload"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  firstFailureAt: text("first_failure_at"),
  updatedAt: text("updated_at").notNull().default(now),
});

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    type: text("type").notNull(),
    category: text("category").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    source: text("source").notNull(),
    deepLink: text("deep_link").notNull(),
    dedupeKey: text("dedupe_key"),
    occurrences: integer("occurrences").notNull().default(1),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
    readAt: text("read_at"),
    dismissedAt: text("dismissed_at"),
    actedAt: text("acted_at"),
    /** outbox: null = no push wanted, "pending" | "sent" | "suppressed" | "failed" */
    pushState: text("push_state"),
    pushAttemptedAt: text("push_attempted_at"),
    scheduledFor: text("scheduled_for"),
  },
  (t) => [uniqueIndex("notifications_dedupe_idx").on(t.userId, t.dedupeKey), index("notifications_created_idx").on(t.createdAt)],
);

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: text("created_at").notNull().default(now),
  lastSuccessAt: text("last_success_at"),
  failureCount: integer("failure_count").notNull().default(0),
});

export const entityLinks = sqliteTable(
  "entity_links",
  {
    id: text("id").primaryKey(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    targetSystem: text("target_system").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    targetIdentifier: text("target_identifier").notNull(),
    targetTitle: text("target_title"),
    relationship: text("relationship").notNull(),
    createdAt: text("created_at").notNull().default(now),
    createdBy: text("created_by").notNull(),
    lastVerifiedAt: text("last_verified_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("entity_links_unique").on(t.sourceType, t.sourceId, t.targetSystem, t.targetType, t.targetId, t.relationship),
    index("entity_links_target_idx").on(t.targetSystem, t.targetId),
  ],
);

/** UI metadata for Hermes sessions that Hermes does not supply itself. */
export const sessionMeta = sqliteTable("session_meta", {
  sessionId: text("session_id").primaryKey(),
  userId: text("user_id").notNull(),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  forkedFromSessionId: text("forked_from_session_id"),
  forkedFromMessageId: text("forked_from_message_id"),
  titleOverride: text("title_override"),
  /** visible to everyone in the household who can chat (read-only for them) */
  shared: integer("shared", { mode: "boolean" }).notNull().default(false),
  lastSeenAt: text("last_seen_at"),
  createdAt: text("created_at").notNull().default(now),
});

/** Runs Jarvis started, tracked until Hermes confirms a terminal state. */
export const runs = sqliteTable(
  "runs",
  {
    runId: text("run_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    userId: text("user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").notNull(),
    inputPreview: text("input_preview"),
    pendingApproval: text("pending_approval"),
    startedAt: text("started_at").notNull().default(now),
    completedAt: text("completed_at"),
    lastCheckedAt: text("last_checked_at"),
    notifiedCompletion: integer("notified_completion", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [index("runs_status_idx").on(t.status)],
);

/** Jarvis-local per-action preferences (pin). Never a copy of upstream state. */
/** Per-person pins and acknowledgements of Home actions. */
export const actionPrefs = sqliteTable(
  "action_prefs",
  {
    userId: text("user_id").notNull().default(""),
    actionId: text("action_id").notNull(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    hiddenUntil: text("hidden_until"),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.actionId] })],
);

/** Built-in todo store — only used when "Jarvis" is the canonical todo provider. */
export const localTodos = sqliteTable("local_todos", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  notes: text("notes"),
  dueAt: text("due_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

/** Jarvis-native Daily Compass check-ins (used when no external store is configured). */
export const compassEntries = sqliteTable("compass_entries", {
  date: text("date").primaryKey(),
  completedAt: text("completed_at"),
  sessionId: text("session_id"),
  note: text("note"),
});

export const idempotency = sqliteTable("idempotency", {
  key: text("key").primaryKey(),
  scope: text("scope").notNull(),
  response: text("response").notNull(),
  createdAt: text("created_at").notNull().default(now),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    at: text("at").notNull().default(now),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    source: text("source"),
    sourceRecord: text("source_record"),
    result: text("result").notNull(),
    correlationId: text("correlation_id").notNull(),
    detail: text("detail"),
  },
  (t) => [index("audit_at_idx").on(t.at)],
);

/** Paired phones (native app). The bearer token is stored only as a sha256 hash. */
export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  platform: text("platform").notNull().default("android"),
  tokenHash: text("token_hash").notNull().unique(),
  appVersion: text("app_version"),
  /** Firebase Cloud Messaging registration token */
  pushToken: text("push_token"),
  pushFailures: integer("push_failures").notNull().default(0),
  createdAt: text("created_at").notNull().default(now),
  lastSeenAt: text("last_seen_at").notNull().default(now),
  revokedAt: text("revoked_at"),
});

/** One-time pairing codes shown as a QR code in Settings; stored hashed, single use. */
export const pairingCodes = sqliteTable("pairing_codes", {
  codeHash: text("code_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().default(now),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});
