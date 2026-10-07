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
