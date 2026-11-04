CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`item_id` text NOT NULL,
	`token_id` text,
	`profile` text NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`summary` text,
	`pr_url` text,
	`hermes_session_id` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_runs_item_idx` ON `agent_runs` (`user_id`,`item_id`);--> statement-breakpoint
CREATE TABLE `agent_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`hint` text NOT NULL,
	`name` text NOT NULL,
	`profile` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tokens_hash_idx` ON `agent_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `agent_tokens_user_idx` ON `agent_tokens` (`user_id`);--> statement-breakpoint
ALTER TABLE `work_events` ADD `via` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD `created_via` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD `updated_via` text;--> statement-breakpoint
ALTER TABLE `work_ops` ADD `via` text;