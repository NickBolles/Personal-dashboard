CREATE TABLE `fin_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`card_basis` text,
	`reserve_account` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`external_source` text,
	`external_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fin_accounts_external_idx` ON `fin_accounts` (`external_source`,`external_id`);--> statement-breakpoint
CREATE TABLE `fin_action_legs` (
	`action_id` text NOT NULL,
	`side` text NOT NULL,
	`account_id` text NOT NULL,
	`inclusion` text DEFAULT 'excluded' NOT NULL,
	`evidence` text,
	`transaction_id` text,
	`confirmed_by` text,
	`confirmed_at` text,
	PRIMARY KEY(`action_id`, `side`),
	FOREIGN KEY (`action_id`) REFERENCES `fin_actions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fin_action_legs_txn_idx` ON `fin_action_legs` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `fin_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`checkin_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`amount` integer NOT NULL,
	`from_account_id` text,
	`to_account_id` text,
	`date` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`fund_id` text,
	`fund_decision` integer DEFAULT false NOT NULL,
	`flow_id` text,
	`card_basis` text,
	`plan_event_id` text,
	`note` text,
	`position` integer DEFAULT 0 NOT NULL,
	`carried_from_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`done_at` text,
	`done_by` text,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`checkin_id`) REFERENCES `fin_checkins`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fin_actual_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`actual_id` text NOT NULL,
	`fund_id` text,
	`amount` integer NOT NULL,
	`correction` integer DEFAULT false NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`actual_id`) REFERENCES `fin_actuals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fin_actuals` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`note` text,
	`action_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `fin_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fin_actuals_action_id_unique` ON `fin_actuals` (`action_id`);--> statement-breakpoint
CREATE TABLE `fin_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`balance` integer NOT NULL,
	`semantics` text NOT NULL,
	`source` text NOT NULL,
	`as_of` text,
	`fetched_at` text NOT NULL,
	`run_id` text,
	`statement_balance` integer,
	`statement_payments_credited` integer,
	`statement_due_date` text,
	`entered_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `fin_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fin_balances_account_idx` ON `fin_balances` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `fin_checkin_balances` (
	`checkin_id` text NOT NULL,
	`account_id` text NOT NULL,
	`balance_id` text NOT NULL,
	PRIMARY KEY(`checkin_id`, `account_id`),
	FOREIGN KEY (`checkin_id`) REFERENCES `fin_checkins`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fin_checkins` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`snapshot_at` text,
	`acknowledged` text DEFAULT '[]' NOT NULL,
	`close_note` text,
	`summary` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`closed_at` text,
	`closed_by` text,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fin_checkins_month_unique` ON `fin_checkins` (`month`);--> statement-breakpoint
CREATE TABLE `fin_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fin_comments_target_idx` ON `fin_comments` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `fin_event_estimates` (
	`revision_id` text NOT NULL,
	`event_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`allocations` text DEFAULT '{}' NOT NULL,
	`removed` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`revision_id`, `event_id`),
	FOREIGN KEY (`revision_id`) REFERENCES `fin_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `fin_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fin_events` (
	`id` text PRIMARY KEY NOT NULL,
	`year` integer NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`remaining_amount` integer,
	`imported` integer DEFAULT false NOT NULL,
	`provenance` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fin_external_accounts` (
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text,
	`ignored` integer DEFAULT false NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`source`, `external_id`)
);
--> statement-breakpoint
CREATE TABLE `fin_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`account_id` text NOT NULL,
	`amount` integer NOT NULL,
	`date` text NOT NULL,
	`recurrence` text DEFAULT 'none' NOT NULL,
	`reliable` integer DEFAULT false NOT NULL,
	`fund_id` text,
	`active` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fin_fund_holdings` (
	`fund_id` text NOT NULL,
	`account_id` text NOT NULL,
	`amount` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`fund_id`, `account_id`),
	FOREIGN KEY (`fund_id`) REFERENCES `fin_funds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `fin_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fin_fund_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`fund_id` text NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`action_id` text,
	`cycle` integer DEFAULT 0 NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fin_fund_movements_once_idx` ON `fin_fund_movements` (`action_id`,`fund_id`,`account_id`,`kind`,`cycle`);--> statement-breakpoint
CREATE TABLE `fin_funds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`protected` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fin_plan_years` (
	`year` integer PRIMARY KEY NOT NULL,
	`active_revision_id` text
);
--> statement-breakpoint
CREATE TABLE `fin_revision_funds` (
	`revision_id` text NOT NULL,
	`fund_id` text NOT NULL,
	`opening` integer DEFAULT 0 NOT NULL,
	`goal` integer,
	`rollover_note` text,
	PRIMARY KEY(`revision_id`, `fund_id`),
	FOREIGN KEY (`revision_id`) REFERENCES `fin_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `fin_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`year` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`based_on_id` text,
	`change_note` text NOT NULL,
	`provenance` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`promoted_at` text,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fin_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`requested_by` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text,
	`lease_until` text,
	`error` text,
	`detail` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `fin_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`source` text NOT NULL,
	`source_txn_id` text NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`pending` integer DEFAULT false NOT NULL,
	`superseded_by` text,
	`ambiguous` integer DEFAULT false NOT NULL,
	`run_id` text,
	`imported_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `fin_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fin_transactions_identity_idx` ON `fin_transactions` (`source`,`account_id`,`source_txn_id`);--> statement-breakpoint
CREATE INDEX `fin_transactions_date_idx` ON `fin_transactions` (`date`);