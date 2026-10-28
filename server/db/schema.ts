import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

/**
 * Failed sign-in counters (server/auth/throttle.ts): per client, per account
 * and global. Times are epoch milliseconds.
 */
export const authFailures = sqliteTable("auth_failures", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  firstAt: integer("first_at").notNull(),
  lastAt: integer("last_at").notNull(),
  lockedUntil: integer("locked_until").notNull().default(0),
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
  /** "android-app" when subscribed inside the Jarvis Android app (TWA); skipped when that phone gets FCM. */
  source: text("source"),
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
  /** Hermes profile the session lives on (null = default profile); fixed at creation (Settings → Agents routing) */
  hermesProfile: text("hermes_profile"),
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
    /** Hermes profile the run executes on (null = default profile) */
    hermesProfile: text("hermes_profile"),
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
    /** Explicit acknowledgement, independent of generic feedback snoozes. */
    acknowledgedUntil: text("acknowledged_until"),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.actionId] })],
);

/**
 * Per-person feedback on Home cards (docs/home-priorities.md). Rows are never
 * edited: a person can delete their own, or reset all of it.
 */
export const homeFeedback = sqliteTable(
  "home_feedback",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    /** action | assist */
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    category: text("category").notNull(),
    /** helpful | not_helpful | not_now | less_like_this | wrong_assumption */
    verdict: text("verdict").notNull(),
    correction: text("correction"),
    fingerprint: text("fingerprint").notNull(),
    /** JSON {version, fingerprint, why[], sources[]}: what the card said when the person reacted */
    provenance: text("provenance").notNull(),
    snoozeUntil: text("snooze_until"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("home_feedback_idem_idx").on(t.userId, t.idempotencyKey), index("home_feedback_target_idx").on(t.userId, t.targetId)],
);

/** Per-person category weights the ranking reads (−2…+1, 0 = no row). */
export const homeCategoryPrefs = sqliteTable(
  "home_category_prefs",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    weight: integer("weight").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.category] })],
);

/** Dates a person saved for planning ahead (birthdays, anniversaries). Private to them. */
export const homeMilestones = sqliteTable(
  "home_milestones",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** YYYY-MM-DD; for yearly dates only month and day matter */
    date: text("date").notNull(),
    yearly: integer("yearly", { mode: "boolean" }).notNull().default(true),
    leadDays: integer("lead_days").notNull().default(60),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("home_milestones_user_idx").on(t.userId)],
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

/* ------------------------------------------------------------------ finance
 * Household month-end check-in and long-term plan (docs/finance.md). Money is
 * integer cents; assets positive, liabilities negative. Nothing here moves
 * money. Every money-affecting row has a version for optimistic concurrency.
 */

export const finAccounts = sqliteTable(
  "fin_accounts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** checking | savings | credit_card | other_asset | other_liability */
    kind: text("kind").notNull(),
    /** cards: statement | current, chosen explicitly */
    cardBasis: text("card_basis"),
    reserveAccount: integer("reserve_account", { mode: "boolean" }).notNull().default(false),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    /** mapping to one provider record (no masks stored) */
    externalSource: text("external_source"),
    externalId: text("external_id"),
    position: integer("position").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("fin_accounts_external_idx").on(t.externalSource, t.externalId)],
);

/** Provider account records seen during a refresh, for mapping. */
export const finExternalAccounts = sqliteTable(
  "fin_external_accounts",
  {
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    type: text("type"),
    /** the user marked it a duplicate of another record (never mapped) */
    ignored: integer("ignored", { mode: "boolean" }).notNull().default(false),
    lastSeenAt: text("last_seen_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.source, t.externalId] })],
);

export const finBalances = sqliteTable(
  "fin_balances",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => finAccounts.id, { onDelete: "cascade" }),
    balance: integer("balance").notNull(),
    /** current | available | statement */
    semantics: text("semantics").notNull(),
    /** monarch | manual | csv */
    source: text("source").notNull(),
    /** provider's as-of; null when unknown (never copied from fetch time) */
    asOf: text("as_of"),
    fetchedAt: text("fetched_at").notNull(),
    runId: text("run_id"),
    statementBalance: integer("statement_balance"),
    statementPaymentsCredited: integer("statement_payments_credited"),
    statementDueDate: text("statement_due_date"),
    enteredBy: text("entered_by"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("fin_balances_account_idx").on(t.accountId, t.createdAt)],
);

/** A refresh or import. The lease keeps two from running at once (and close from racing one). */
export const finRuns = sqliteTable("fin_runs", {
  id: text("id").primaryKey(),
  /** monarch | csv | manual */
  kind: text("kind").notNull(),
  requestedBy: text("requested_by").notNull(),
  /** running | succeeded | partial | failed */
  status: text("status").notNull(),
  /** ready | attention | failed, once terminal */
  outcome: text("outcome"),
  leaseUntil: text("lease_until"),
  error: text("error"),
  detail: text("detail"),
  startedAt: text("started_at").notNull().default(now),
  finishedAt: text("finished_at"),
});

export const finTransactions = sqliteTable(
  "fin_transactions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => finAccounts.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    /** provider id, or for CSV a content hash plus occurrence number within the file */
    sourceTxnId: text("source_txn_id").notNull(),
    date: text("date").notNull(),
    amount: integer("amount").notNull(),
    description: text("description").notNull().default(""),
    pending: integer("pending", { mode: "boolean" }).notNull().default(false),
    /** a later record (e.g. the posted version of a pending one) replaces this one */
    supersededBy: text("superseded_by"),
    /** overlaps a record from another source; needs a person to decide */
    ambiguous: integer("ambiguous", { mode: "boolean" }).notNull().default(false),
    runId: text("run_id"),
    importedAt: text("imported_at").notNull().default(now),
  },
  (t) => [uniqueIndex("fin_transactions_identity_idx").on(t.source, t.accountId, t.sourceTxnId), index("fin_transactions_date_idx").on(t.date)],
);

export const finCheckins = sqliteTable("fin_checkins", {
  id: text("id").primaryKey(),
  /** YYYY-MM */
  month: text("month").notNull().unique(),
  /** draft | closed */
  status: text("status").notNull().default("draft"),
  snapshotAt: text("snapshot_at"),
  /** warnings acknowledged (issue keys) with who/why */
  acknowledged: text("acknowledged").notNull().default("[]"),
  closeNote: text("close_note"),
  /** frozen result at close */
  summary: text("summary"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now),
  closedAt: text("closed_at"),
  closedBy: text("closed_by"),
  version: integer("version").notNull().default(1),
});

/** The balances a check-in is computed from (stable until someone re-snapshots). */
export const finCheckinBalances = sqliteTable(
  "fin_checkin_balances",
  {
    checkinId: text("checkin_id")
      .notNull()
      .references(() => finCheckins.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    balanceId: text("balance_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.checkinId, t.accountId] })],
);

export const finActions = sqliteTable("fin_actions", {
  id: text("id").primaryKey(),
  checkinId: text("checkin_id")
    .notNull()
    .references(() => finCheckins.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  amount: integer("amount").notNull(),
  fromAccountId: text("from_account_id"),
  toAccountId: text("to_account_id"),
  date: text("date"),
  status: text("status").notNull().default("planned"),
  fundId: text("fund_id"),
  fundDecision: integer("fund_decision", { mode: "boolean" }).notNull().default(false),
  flowId: text("flow_id"),
  cardBasis: text("card_basis"),
  planEventId: text("plan_event_id"),
  note: text("note"),
  position: integer("position").notNull().default(0),
  carriedFromId: text("carried_from_id"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
  doneAt: text("done_at"),
  doneBy: text("done_by"),
  version: integer("version").notNull().default(1),
});

/** Each side of an action and whether it's already in the snapshot, with evidence. */
export const finActionLegs = sqliteTable(
  "fin_action_legs",
  {
    actionId: text("action_id")
      .notNull()
      .references(() => finActions.id, { onDelete: "cascade" }),
    side: text("side").notNull(),
    accountId: text("account_id").notNull(),
    /** included | excluded | unknown */
    inclusion: text("inclusion").notNull().default("excluded"),
    evidence: text("evidence"),
    transactionId: text("transaction_id"),
    confirmedBy: text("confirmed_by"),
    confirmedAt: text("confirmed_at"),
  },
  (t) => [primaryKey({ columns: [t.actionId, t.side] }), uniqueIndex("fin_action_legs_txn_idx").on(t.transactionId)],
);

export const finFunds = sqliteTable("fin_funds", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  protected: integer("protected", { mode: "boolean" }).notNull().default(false),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  position: integer("position").notNull().default(0),
  version: integer("version").notNull().default(1),
});

export const finFundHoldings = sqliteTable(
  "fin_fund_holdings",
  {
    fundId: text("fund_id")
      .notNull()
      .references(() => finFunds.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => finAccounts.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    version: integer("version").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.fundId, t.accountId] })],
);

/** Every change to a fund holding, so a draw can be recorded exactly once per action. */
export const finFundMovements = sqliteTable(
  "fin_fund_movements",
  {
    id: text("id").primaryKey(),
    fundId: text("fund_id").notNull(),
    accountId: text("account_id").notNull(),
    /** set | consume | release */
    kind: text("kind").notNull(),
    amount: integer("amount").notNull(),
    actionId: text("action_id"),
    /** consume/release cycle for the action: one consumption per cycle, ever */
    cycle: integer("cycle").notNull().default(0),
    note: text("note"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("fin_fund_movements_once_idx").on(t.actionId, t.fundId, t.accountId, t.kind, t.cycle)],
);

/** Reserve schedule: dated bills and paychecks. */
export const finFlows = sqliteTable("fin_flows", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  accountId: text("account_id").notNull(),
  amount: integer("amount").notNull(),
  /** next (or only) date */
  date: text("date").notNull(),
  /** none | weekly | biweekly | monthly | yearly */
  recurrence: text("recurrence").notNull().default("none"),
  reliable: integer("reliable", { mode: "boolean" }).notNull().default(false),
  fundId: text("fund_id"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  version: integer("version").notNull().default(1),
});

export const finPlanYears = sqliteTable("fin_plan_years", {
  year: integer("year").primaryKey(),
  activeRevisionId: text("active_revision_id"),
});

export const finRevisions = sqliteTable("fin_revisions", {
  id: text("id").primaryKey(),
  year: integer("year").notNull(),
  name: text("name").notNull(),
  /** active | hypothetical | archived (read-only) */
  kind: text("kind").notNull(),
  basedOnId: text("based_on_id"),
  changeNote: text("change_note").notNull(),
  /** spreadsheet import: tab, block, range, time */
  provenance: text("provenance"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now),
  promotedAt: text("promoted_at"),
  version: integer("version").notNull().default(1),
});

/** Opening fund positions per revision (explicit, including year-to-year rollovers). */
export const finRevisionFunds = sqliteTable(
  "fin_revision_funds",
  {
    revisionId: text("revision_id")
      .notNull()
      .references(() => finRevisions.id, { onDelete: "cascade" }),
    fundId: text("fund_id").notNull(),
    opening: integer("opening").notNull().default(0),
    goal: integer("goal"),
    rolloverNote: text("rollover_note"),
  },
  (t) => [primaryKey({ columns: [t.revisionId, t.fundId] })],
);

/** Events have one identity across revisions; actuals hang off the event. */
export const finEvents = sqliteTable("fin_events", {
  id: text("id").primaryKey(),
  year: integer("year").notNull(),
  label: text("label").notNull(),
  /** income | obligation | reallocation */
  kind: text("kind").notNull(),
  /** open | partial | complete */
  status: text("status").notNull().default("open"),
  remainingAmount: integer("remaining_amount"),
  imported: integer("imported", { mode: "boolean" }).notNull().default(false),
  provenance: text("provenance"),
  createdAt: text("created_at").notNull().default(now),
  version: integer("version").notNull().default(1),
});

export const finEventEstimates = sqliteTable(
  "fin_event_estimates",
  {
    revisionId: text("revision_id")
      .notNull()
      .references(() => finRevisions.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => finEvents.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    amount: integer("amount").notNull(),
    /** JSON {fundId: cents} */
    allocations: text("allocations").notNull().default("{}"),
    removed: integer("removed", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.revisionId, t.eventId] })],
);

/** A confirmed installment of an event. */
export const finActuals = sqliteTable("fin_actuals", {
  id: text("id").primaryKey(),
  eventId: text("event_id")
    .notNull()
    .references(() => finEvents.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  amount: integer("amount").notNull(),
  note: text("note"),
  actionId: text("action_id").unique(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now),
});

/** Stored fund effects of an actual (fundId null = explicit unallocated). Corrections are new rows. */
export const finActualAllocations = sqliteTable("fin_actual_allocations", {
  id: text("id").primaryKey(),
  actualId: text("actual_id")
    .notNull()
    .references(() => finActuals.id, { onDelete: "cascade" }),
  fundId: text("fund_id"),
  amount: integer("amount").notNull(),
  correction: integer("correction", { mode: "boolean" }).notNull().default(false),
  note: text("note"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull().default(now),
});

export const finComments = sqliteTable(
  "fin_comments",
  {
    id: text("id").primaryKey(),
    /** event | revision | checkin | action */
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    userId: text("user_id").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("fin_comments_target_idx").on(t.targetType, t.targetId)],
);

/* -------------------------------------------------------------- assistant
 * Conversations with a direct model (Claude) instead of Hermes. Ownership,
 * pin/archive/share live in session_meta like Hermes sessions; runs use the
 * shared runs table. Hermes keeps its own transcripts; these are Jarvis's.
 */
// Private workout documents and retry receipts; no upstream/canonical data is mutated.
export const workoutSessions = sqliteTable(
  "workout_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    document: text("document").notNull(),
    source: text("source"),
    sourceId: text("source_id"),
    sourceHash: text("source_hash"),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("workout_owner_idx").on(t.userId), uniqueIndex("workout_import_idx").on(t.userId, t.sourceId)],
);

export const workoutRequests = sqliteTable(
  "workout_requests",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestId: text("request_id").notNull(),
    hash: text("hash").notNull(),
    response: text("response").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.requestId] })],
);

export const aiSessions = sqliteTable("ai_sessions", {
  /** loc_… */
  id: text("id").primaryKey(),
  /** claude */
  backend: text("backend").notNull(),
  model: text("model").notNull(),
  title: text("title").notNull().default("New conversation"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

export const aiMessages = sqliteTable(
  "ai_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => aiSessions.id, { onDelete: "cascade" }),
    /** user | assistant */
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** summarized reasoning shown under the reply (assistant only) */
    reasoning: text("reasoning"),
    runId: text("run_id"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("ai_messages_session_idx").on(t.sessionId, t.createdAt)],
);

/**
 * Work hub (docs/work.md): a private, per-person hierarchy of AI-assisted work.
 * Areas are top-level items (parent_id null). Packets, lineage and events are
 * append-only; GitHub stays the system of record for PR state (links only mirror it).
 */
export const workItems = sqliteTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    /** area | project | thread | investigation | note | conversation */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    nextAction: text("next_action").notNull().default(""),
    /** lib/work.ts WORK_STATUSES */
    status: text("status").notNull().default("captured"),
    sortOrder: integer("sort_order").notNull().default(0),
    startDate: text("start_date"),
    targetDate: text("target_date"),
    completedAt: text("completed_at"),
    /** manual | auto */
    settledKind: text("settled_kind"),
    settledReason: text("settled_reason"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    /** "misc" for the built-in Miscellaneous area */
    systemKey: text("system_key"),
    /** areas only: required | optional; null = by rule (Miscellaneous and Home optional, others required; lib/work.ts areaValidationDefault) */
    validationDefault: text("validation_default"),
    /** conversation nodes: the Hermes/Claude session id (one node per session per owner) */
    sessionId: text("session_id"),
    /** areas only: JSON AreaSettings (lib/work.ts parseAreaSettings); null = defaults */
    settings: text("settings"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    index("work_items_owner_idx").on(t.userId, t.parentId),
    uniqueIndex("work_items_system_idx").on(t.userId, t.systemKey),
    uniqueIndex("work_items_session_idx").on(t.userId, t.sessionId),
  ],
);

export const workLinks = sqliteTable(
  "work_links",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    /** chat_session | github_pr | github_issue | url */
    kind: text("kind").notNull(),
    /** session id, or owner/repo#number for GitHub */
    targetId: text("target_id"),
    url: text("url"),
    title: text("title").notNull().default(""),
    /** source | implementation | evidence | reference */
    role: text("role").notNull().default("reference"),
    /** open | merged | closed */
    externalState: text("external_state"),
    stateChangedAt: text("state_changed_at"),
    /** "handoff_from": a conversation started from this item's handoff ("Continue in new conversation") */
    lineage: text("lineage"),
    /** the packet the handoff was written from (null when the item had none) */
    packetId: text("packet_id"),
    /** last read-only GitHub readback attempt (throttles automatic refresh) */
    checkedAt: text("checked_at"),
    /** why the last readback failed (cleared on success) */
    checkError: text("check_error"),
    /** PRs: combined CI state of the head commit (success | failure | pending), from check suites + commit statuses; null = unknown */
    checksState: text("checks_state"),
    checksAt: text("checks_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("work_links_item_idx").on(t.itemId)],
);

export const workLineage = sqliteTable(
  "work_lineage",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    childId: text("child_id").notNull(),
    /** the related source item (fork/split source; the previous parent for a move) */
    parentId: text("parent_id"),
    /** forked_from | split_from | moved_from | handoff_from */
    relation: text("relation").notNull(),
    note: text("note"),
    fromParentId: text("from_parent_id"),
    toParentId: text("to_parent_id"),
    actor: text("actor").notNull(),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("work_lineage_child_idx").on(t.childId), index("work_lineage_parent_idx").on(t.parentId)],
);

export const workPackets = sqliteTable(
  "work_packets",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    objective: text("objective").notNull(),
    inScope: text("in_scope").notNull().default(""),
    outOfScope: text("out_of_scope").notNull().default(""),
    acceptanceCriteria: text("acceptance_criteria").notNull().default(""),
    decisions: text("decisions").notNull().default(""),
    openQuestions: text("open_questions").notNull().default(""),
    context: text("context").notNull().default(""),
    validationRequired: integer("validation_required", { mode: "boolean" }).notNull().default(true),
    noValidationReason: text("no_validation_reason"),
    createdAt: text("created_at").notNull().default(now),
    createdBy: text("created_by").notNull(),
  },
  (t) => [uniqueIndex("work_packets_version_idx").on(t.itemId, t.version)],
);

export const workValidations = sqliteTable(
  "work_validations",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    /** <= | >= | < | > | = */
    comparator: text("comparator").notNull(),
    threshold: real("threshold").notNull(),
    unit: text("unit").notNull().default(""),
    baseline: real("baseline"),
    observed: real("observed"),
    evidenceUrl: text("evidence_url"),
    notes: text("notes"),
    /** pending | pass | fail | waived */
    status: text("status").notNull().default("pending"),
    waiverReason: text("waiver_reason"),
    dueDate: text("due_date"),
    recordedAt: text("recorded_at"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("work_validations_item_idx").on(t.itemId)],
);

export const workEvents = sqliteTable(
  "work_events",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    /** status | created | merged | closed | packet | validation | link | edit */
    kind: text("kind").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    reason: text("reason"),
    actor: text("actor").notNull(),
    /** where a change came from: manual | github (read-only refresh); null for ordinary edits */
    source: text("source"),
    at: text("at").notNull().default(now),
  },
  (t) => [index("work_events_item_idx").on(t.itemId, t.at)],
);

/** Per-person reusable validation templates ("Add from template"). Nothing is seeded. */
export const workValidationTemplates = sqliteTable(
  "work_validation_templates",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    metric: text("metric").notNull(),
    /** <= | >= | < | > | = */
    comparator: text("comparator").notNull(),
    threshold: real("threshold").notNull(),
    unit: text("unit").notNull().default(""),
    /** due date = the day it's applied + this many days (null: no due date) */
    dueOffsetDays: integer("due_offset_days"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("work_validation_templates_owner_idx").on(t.userId)],
);

/** "item depends on item" (blocked-by). Cycle-safe (server/work/lifecycle.ts); drawn as Gantt connectors. */
export const workDependencies = sqliteTable(
  "work_dependencies",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("work_dependencies_pair_idx").on(t.itemId, t.dependsOnId), index("work_dependencies_on_idx").on(t.dependsOnId)],
);

/**
 * Structural operations that can be undone (move, reorder, archive, split/fork
 * creation). Undo is only allowed for the latest operation on an item, within
 * a short window, and once (server/work/undo-rules.ts).
 */
export const workOps = sqliteTable(
  "work_ops",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    itemId: text("item_id").notNull(),
    /** move | reorder | archive | unarchive | split | fork */
    kind: text("kind").notNull(),
    /** JSON: what undo needs (previous parent and sibling order, copied link count, …) */
    payload: text("payload").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(now),
    undoneAt: text("undone_at"),
  },
  (t) => [index("work_ops_item_idx").on(t.userId, t.itemId, t.createdAt)],
);

/**
 * GitHub connections for the Work hub (Settings → Connections → GitHub): one
 * read-only token per GitHub owner (user or org). The token is AES-256-GCM
 * encrypted (server/crypto.ts) and never returned to a browser; only its last
 * four characters are shown.
 */
export const githubConnections = sqliteTable(
  "github_connections",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    /** GitHub user or organization login, as entered */
    owner: text("owner").notNull(),
    /** lowercase owner: one connection per owner */
    ownerKey: text("owner_key").notNull(),
    tokenCipher: text("token_cipher").notNull(),
    tokenLast4: text("token_last4").notNull(),
    /** JSON array of repository names under `owner`; empty = every repo the token can see */
    repos: text("repos").notNull().default("[]"),
    /** the Jarvis person whose Work inbox receives this token's assigned issues */
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** GitHub login of the token (from the last Test), used for assigned-issue webhooks */
    login: text("login"),
    lastTestAt: text("last_test_at"),
    lastTestOk: integer("last_test_ok", { mode: "boolean" }),
    lastTestResult: text("last_test_result"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("github_connections_owner_idx").on(t.ownerKey)],
);

/**
 * Work inbox (docs/work.md): GitHub issues assigned to you, quick captures and
 * dismissed conversations (id only: Hermes owns conversation content).
 * Accepting files it as a Work item; dismissing hides it for good.
 */
export const workInbox = sqliteTable(
  "work_inbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** github_issue | capture | conversation (a dismissed unfiled conversation; id only) */
    source: text("source").notNull(),
    /** GitHub issue node id, or the conversation id; null for captures */
    externalId: text("external_id"),
    connectionId: text("connection_id"),
    title: text("title").notNull().default(""),
    note: text("note").notNull().default(""),
    url: text("url"),
    /** owner/repo for GitHub issues */
    repo: text("repo"),
    number: integer("number"),
    /** open | closed (closed or unassigned issues leave the inbox) */
    state: text("state").notNull().default("open"),
    /** why it's here, shown on the row */
    reason: text("reason").notNull().default(""),
    dismissedAt: text("dismissed_at"),
    acceptedAt: text("accepted_at"),
    acceptedItemId: text("accepted_item_id"),
    /** captures (phase 5): web | pwa_share | android | shortcut | voice | api */
    channel: text("channel"),
    deviceId: text("device_id"),
    captureTokenId: text("capture_token_id"),
    /** offline replays dedupe on (user_id, client_capture_id) */
    clientCaptureId: text("client_capture_id"),
    /** none | queued | done | failed | skipped */
    triageState: text("triage_state").notNull().default("none"),
    triageSkipReason: text("triage_skip_reason"),
    suggestedTitle: text("suggested_title"),
    suggestedKind: text("suggested_kind"),
    /** a work item id; validated against the person's tree when read */
    suggestedParentId: text("suggested_parent_id"),
    suggestionConfidence: real("suggestion_confidence"),
    suggestionReason: text("suggestion_reason"),
    /** none | personal | finance | credentials */
    sensitivity: text("sensitivity").notNull().default("none"),
    latestReportId: text("latest_report_id"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("work_inbox_external_idx").on(t.userId, t.source, t.externalId),
    index("work_inbox_owner_idx").on(t.userId, t.state),
    uniqueIndex("work_inbox_client_capture_idx").on(t.userId, t.clientCaptureId),
    index("work_inbox_token_idx").on(t.captureTokenId, t.createdAt),
  ],
);

/**
 * Background AI jobs (phase 5, docs/work.md "AI actions"). Rows never store
 * prompts, model output or provider error text: only controlled codes and
 * messages. Outputs persist solely as validated ai_reports.
 */
export const aiJobs = sqliteTable(
  "ai_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** research | plan | schedule | draft | triage | investigate */
    kind: text("kind").notNull(),
    /** work_item | inbox */
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    areaId: text("area_id"),
    /** lib/ai.ts JOB_STATES */
    state: text("state").notNull().default("queued"),
    /** triage | work */
    lane: text("lane").notNull(),
    /** triage | standard | deep */
    tier: text("tier").notNull(),
    model: text("model"),
    hermesProfile: text("hermes_profile"),
    visibleSession: integer("visible_session", { mode: "boolean" }).notNull().default(false),
    hermesSessionId: text("hermes_session_id"),
    hermesRunId: text("hermes_run_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    params: text("params").notNull().default("{}"),
    promptVersion: text("prompt_version").notNull(),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    notBefore: text("not_before").notNull().default(now),
    leaseOwner: text("lease_owner"),
    leaseUntil: text("lease_until"),
    cancelRequestedAt: text("cancel_requested_at"),
    budgetOverride: integer("budget_override", { mode: "boolean" }).notNull().default(false),
    estimateUsd: real("estimate_usd").notNull().default(0),
    costUsd: real("cost_usd"),
    /** hermes_actual | hermes_estimate | jarvis_estimate */
    costSource: text("cost_source"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    reportId: text("report_id"),
    createdAt: text("created_at").notNull().default(now),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("ai_jobs_idem_idx").on(t.idempotencyKey),
    index("ai_jobs_claim_idx").on(t.state, t.lane, t.notBefore),
    index("ai_jobs_subject_idx").on(t.userId, t.subjectType, t.subjectId, t.createdAt),
    index("ai_jobs_ledger_idx").on(t.userId, t.finishedAt),
  ],
);

/** Validated AI reports (research, plan, schedule, draft, investigate), owned by Jarvis and exportable. */
export const aiReports = sqliteTable(
  "ai_reports",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jobId: text("job_id").notNull(),
    kind: text("kind").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    originInboxId: text("origin_inbox_id"),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    bodyMd: text("body_md").notNull().default(""),
    structured: text("structured").notNull().default("{}"),
    /** low | medium | high */
    confidence: text("confidence").notNull().default("low"),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    costUsd: real("cost_usd"),
    conversationId: text("conversation_id"),
    readAt: text("read_at"),
    pinnedAt: text("pinned_at"),
    archivedAt: text("archived_at"),
    /** JSON { value: useful | not_useful, note? } */
    feedback: text("feedback"),
    supersededBy: text("superseded_by"),
    createdAt: text("created_at").notNull().default(now),
  },
  (t) => [index("ai_reports_subject_idx").on(t.userId, t.subjectType, t.subjectId, t.createdAt), index("ai_reports_unread_idx").on(t.userId, t.readAt)],
);

export const aiReportSources = sqliteTable(
  "ai_report_sources",
  {
    reportId: text("report_id")
      .notNull()
      .references(() => aiReports.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    /** web | github | work_item | conversation | attachment | calendar */
    kind: text("kind").notNull().default("web"),
    url: text("url"),
    title: text("title").notNull().default(""),
    quote: text("quote"),
    accessedAt: text("accessed_at"),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.idx] })],
);

/** Files attached to captures. Stored outside public/ under the data dir; served only by the authenticated route. */
export const captureAttachments = sqliteTable(
  "capture_attachments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    inboxId: text("inbox_id")
      .notNull()
      .references(() => workInbox.id, { onDelete: "cascade" }),
    /** image | text */
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    width: integer("width"),
    height: integer("height"),
    /** the work item it was re-pointed to when the entry was filed */
    itemId: text("item_id"),
    createdAt: text("created_at").notNull().default(now),
    deletedAt: text("deleted_at"),
  },
  (t) => [index("capture_attachments_inbox_idx").on(t.inboxId)],
);

/** Capture-only bearer tokens (jcap_…) for HTTP Shortcuts/Tasker. sha256 at rest, shown once. */
export const captureTokens = sqliteTable(
  "capture_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefixHint: text("prefix_hint").notNull(),
    ratePerHour: integer("rate_per_hour").notNull().default(30),
    ratePerDay: integer("rate_per_day").notNull().default(300),
    /** inherit | triage_only | off */
    investigateMode: text("investigate_mode").notNull().default("inherit"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(now),
    lastUsedAt: text("last_used_at"),
    useCount: integer("use_count").notNull().default(0),
    revokedAt: text("revoked_at"),
  },
  (t) => [uniqueIndex("capture_tokens_hash_idx").on(t.tokenHash), index("capture_tokens_owner_idx").on(t.userId)],
);

/**
 * The read-only GitHub App Jarvis created through the manifest flow (Settings
 * → Connections → GitHub → Create GitHub App). At most one. Client secret,
 * private key (PEM) and webhook secret are AES-256-GCM encrypted
 * (server/crypto.ts) and never leave the server.
 */
export const githubApps = sqliteTable("github_apps", {
  id: text("id").primaryKey(),
  /** GitHub's numeric App id (the JWT `iss`) */
  appId: integer("app_id").notNull(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  /** the account that owns the App registration */
  ownerLogin: text("owner_login").notNull(),
  ownerType: text("owner_type").notNull().default("User"),
  htmlUrl: text("html_url"),
  clientId: text("client_id").notNull(),
  /** null when the App was connected by id + private key (no client secret needed for read access) */
  clientSecretCipher: text("client_secret_cipher"),
  pemCipher: text("pem_cipher").notNull(),
  /** null when GitHub didn't return one (webhooks then need the legacy secret) */
  webhookSecretCipher: text("webhook_secret_cipher"),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

/** Installations of the App (accounts it was installed on), refreshed via the App JWT and installation webhooks. */
export const githubAppInstallations = sqliteTable("github_app_installations", {
  /** GitHub installation id */
  id: integer("id").primaryKey(),
  appRowId: text("app_row_id")
    .notNull()
    .references(() => githubApps.id, { onDelete: "cascade" }),
  accountLogin: text("account_login").notNull(),
  /** lowercase login, matched against repo owners and the account allowlist */
  accountKey: text("account_key").notNull(),
  /** User | Organization */
  accountType: text("account_type").notNull().default("User"),
  /** all | selected */
  repositorySelection: text("repository_selection").notNull().default("selected"),
  /** JSON array of repository names the installation covers (as last read); null = not read yet */
  repos: text("repos"),
  suspended: integer("suspended", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull().default(now),
});

/**
 * One-time `state` values for the manifest flow: sha256 of the state, bound to
 * the admin and their session, short-lived (10 min), deleted when used.
 */
export const githubAppStates = sqliteTable("github_app_states", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** sha256 of the session cookie (or "proxy:<user>" in proxy auth mode) */
  sessionKey: text("session_key").notNull(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(now),
});

/** X-GitHub-Delivery ids already handled by the read-only webhook (dedupe; pruned after 7 days). */
export const workGithubDeliveries = sqliteTable("work_github_deliveries", {
  id: text("id").primaryKey(),
  event: text("event").notNull(),
  outcome: text("outcome").notNull().default(""),
  receivedAt: text("received_at").notNull().default(now),
});

export const dashboards = sqliteTable("dashboards", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Dashboard"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

export const dashboardWidgets = sqliteTable(
  "dashboard_widgets",
  {
    id: text("id").primaryKey(),
    dashboardId: text("dashboard_id")
      .notNull()
      .references(() => dashboards.id, { onDelete: "cascade" }),
    /** lib/work.ts WIDGET_KINDS */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    config: text("config").notNull().default("{}"),
    position: integer("position").notNull().default(0),
    /** sm | md | lg */
    size: text("size").notNull().default("md"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [index("dashboard_widgets_idx").on(t.dashboardId, t.position)],
);

/**
 * Per-person persisted Hermes conversation list: the Areas views render from it
 * at once and refresh it in the background (stale-while-revalidate; Hermes'
 * own list takes 4–9 s). Hermes owns the conversations: rows are a cache of
 * what this person last saw, re-checked for access on every read.
 */
export const conversationIndex = sqliteTable("conversation_index", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** JSON SessionSummary[] (Hermes rows only; Claude-direct ones are read live) */
  sessions: text("sessions").notNull().default("[]"),
  /** false while only the fast first page is stored */
  complete: integer("complete", { mode: "boolean" }).notNull().default(false),
  refreshedAt: text("refreshed_at"),
  attemptedAt: text("attempted_at"),
  lastError: text("last_error"),
  /** last time the person opened a view using it (the warmer skips idle people) */
  accessedAt: text("accessed_at").notNull().default(now),
});

/**
 * Smart-UI surfaces (phase 6, docs/smart-ui.md): one validated `jarvis-ui@1`
 * block from an assistant message. The canonical spec is stored on first
 * render so apply can check that every intent was really offered (and so the
 * surface reopens if Hermes compacts history). Per person; never model text in logs.
 */
export const uiSurfaces = sqliteTable(
  "ui_surfaces",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** message · coordinator · report */
    origin: text("origin").notNull().default("message"),
    sessionId: text("session_id"),
    /** sha256 of the assistant message text (stable across live stream and transcript) */
    messageKey: text("message_key"),
    blockIndex: integer("block_index").notNull().default(0),
    reportId: text("report_id"),
    catalog: text("catalog").notNull(),
    specHash: text("spec_hash").notNull(),
    /** canonical spec JSON (≤ 64 KB) */
    specJson: text("spec_json").notNull(),
    /** UI state: checklist ticks (≤ 16 KB) */
    stateJson: text("state_json").notNull().default("{}"),
    /** JSON AppliedEntry[] */
    appliedJson: text("applied_json").notNull().default("[]"),
    createdAt: text("created_at").notNull().default(now),
    updatedAt: text("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("ui_surfaces_key_idx").on(t.userId, t.sessionId, t.messageKey, t.blockIndex), index("ui_surfaces_session_idx").on(t.sessionId)],
);
