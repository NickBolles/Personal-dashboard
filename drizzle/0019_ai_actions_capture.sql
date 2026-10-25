CREATE TABLE `ai_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`area_id` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`lane` text NOT NULL,
	`tier` text NOT NULL,
	`model` text,
	`hermes_profile` text,
	`visible_session` integer DEFAULT false NOT NULL,
	`hermes_session_id` text,
	`hermes_run_id` text,
	`idempotency_key` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`prompt_version` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 2 NOT NULL,
	`not_before` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`lease_owner` text,
	`lease_until` text,
	`cancel_requested_at` text,
	`budget_override` integer DEFAULT false NOT NULL,
	`estimate_usd` real DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`cost_source` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`error_code` text,
	`error_message` text,
	`report_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_jobs_idem_idx` ON `ai_jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `ai_jobs_claim_idx` ON `ai_jobs` (`state`,`lane`,`not_before`);--> statement-breakpoint
CREATE INDEX `ai_jobs_subject_idx` ON `ai_jobs` (`user_id`,`subject_type`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_jobs_ledger_idx` ON `ai_jobs` (`user_id`,`finished_at`);--> statement-breakpoint
CREATE TABLE `ai_report_sources` (
	`report_id` text NOT NULL,
	`idx` integer NOT NULL,
	`kind` text DEFAULT 'web' NOT NULL,
	`url` text,
	`title` text DEFAULT '' NOT NULL,
	`quote` text,
	`accessed_at` text,
	PRIMARY KEY(`report_id`, `idx`),
	FOREIGN KEY (`report_id`) REFERENCES `ai_reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`origin_inbox_id` text,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`body_md` text DEFAULT '' NOT NULL,
	`structured` text DEFAULT '{}' NOT NULL,
	`confidence` text DEFAULT 'low' NOT NULL,
	`model` text,
	`prompt_version` text NOT NULL,
	`cost_usd` real,
	`conversation_id` text,
	`read_at` text,
	`pinned_at` text,
	`archived_at` text,
	`feedback` text,
	`superseded_by` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_reports_subject_idx` ON `ai_reports` (`user_id`,`subject_type`,`subject_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_reports_unread_idx` ON `ai_reports` (`user_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `capture_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`inbox_id` text NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`width` integer,
	`height` integer,
	`item_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inbox_id`) REFERENCES `work_inbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `capture_attachments_inbox_idx` ON `capture_attachments` (`inbox_id`);--> statement-breakpoint
CREATE TABLE `capture_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix_hint` text NOT NULL,
	`rate_per_hour` integer DEFAULT 30 NOT NULL,
	`rate_per_day` integer DEFAULT 300 NOT NULL,
	`investigate_mode` text DEFAULT 'inherit' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_used_at` text,
	`use_count` integer DEFAULT 0 NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capture_tokens_hash_idx` ON `capture_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `capture_tokens_owner_idx` ON `capture_tokens` (`user_id`);--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `channel` text;--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `device_id` text;--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `capture_token_id` text;--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `client_capture_id` text;--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `triage_state` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `triage_skip_reason` text;--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `suggested_title` text;--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `suggested_kind` text;--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `suggested_parent_id` text;--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `suggestion_confidence` real;--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `suggestion_reason` text;--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `sensitivity` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_inbox` ADD `latest_report_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `work_inbox_client_capture_idx` ON `work_inbox` (`user_id`,`client_capture_id`);--> statement-breakpoint
CREATE INDEX `work_inbox_token_idx` ON `work_inbox` (`capture_token_id`,`created_at`);