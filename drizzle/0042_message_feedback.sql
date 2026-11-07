CREATE TABLE `message_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`surface` text NOT NULL,
	`rating` text NOT NULL,
	`reasons_json` text DEFAULT '[]' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	`profile` text DEFAULT 'default' NOT NULL,
	`area_id` text,
	`model` text,
	`tools_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`fix_requested_at` text,
	`item_id` text,
	`triage_run_id` text,
	`triaged_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_feedback_msg_idx` ON `message_feedback` (`user_id`,`session_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `message_feedback_user_status_idx` ON `message_feedback` (`user_id`,`status`,`created_at`);