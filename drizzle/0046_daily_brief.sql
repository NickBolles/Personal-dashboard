CREATE TABLE `brief_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`brief_id` text NOT NULL,
	`date` text NOT NULL,
	`target_key` text NOT NULL,
	`target_kind` text NOT NULL,
	`verdict` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brief_feedback_target_idx` ON `brief_feedback` (`user_id`,`brief_id`,`target_key`);--> statement-breakpoint
CREATE INDEX `brief_feedback_user_idx` ON `brief_feedback` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `brief_improvements` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_key` text NOT NULL,
	`item_id` text NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text,
	`kind` text DEFAULT 'improve' NOT NULL,
	`target_key` text,
	`intent` text,
	`owns_item` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brief_improvements_key_idx` ON `brief_improvements` (`user_id`,`client_key`);--> statement-breakpoint
CREATE INDEX `brief_improvements_user_idx` ON `brief_improvements` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `brief_improvements_target_idx` ON `brief_improvements` (`user_id`,`target_key`);--> statement-breakpoint
CREATE TABLE `brief_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text DEFAULT 'pattern' NOT NULL,
	`text` text NOT NULL,
	`norm` text NOT NULL,
	`origin` text NOT NULL,
	`state` text NOT NULL,
	`evidence` text DEFAULT '' NOT NULL,
	`brief_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brief_notes_norm_idx` ON `brief_notes` (`user_id`,`norm`);--> statement-breakpoint
CREATE INDEX `brief_notes_user_state_idx` ON `brief_notes` (`user_id`,`state`);--> statement-breakpoint
CREATE TABLE `briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`job_id` text,
	`model` text,
	`doc_json` text NOT NULL,
	`based_on` text DEFAULT '[]' NOT NULL,
	`outcomes` text DEFAULT '{}' NOT NULL,
	`ticks` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `briefs_user_date_idx` ON `briefs` (`user_id`,`date`,`created_at`);--> statement-breakpoint
ALTER TABLE `compass_entries` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `compass_entries` ADD `priorities` text;--> statement-breakpoint
ALTER TABLE `compass_entries` ADD `tomorrow` text;--> statement-breakpoint
ALTER TABLE `compass_entries` ADD `journaled_at` text;