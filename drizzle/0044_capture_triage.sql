CREATE TABLE `capture_triage` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`inbox_id` text NOT NULL,
	`state` text DEFAULT 'planned' NOT NULL,
	`plan_json` text DEFAULT '{}' NOT NULL,
	`action_hash` text,
	`backfill` integer DEFAULT false NOT NULL,
	`chosen_json` text,
	`summary` text DEFAULT '' NOT NULL,
	`item_id` text,
	`skylight_write_id` text,
	`decision_id` text,
	`run_id` text,
	`profile` text,
	`error_code` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`not_before` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capture_triage_inbox_idx` ON `capture_triage` (`inbox_id`);--> statement-breakpoint
CREATE INDEX `capture_triage_state_idx` ON `capture_triage` (`state`,`not_before`);--> statement-breakpoint
CREATE INDEX `capture_triage_item_idx` ON `capture_triage` (`item_id`);--> statement-breakpoint
CREATE INDEX `capture_triage_decision_idx` ON `capture_triage` (`decision_id`);