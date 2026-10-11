CREATE TABLE `home_category_prefs` (
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`weight` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`user_id`, `category`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `home_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`category` text NOT NULL,
	`verdict` text NOT NULL,
	`correction` text,
	`fingerprint` text NOT NULL,
	`provenance` text NOT NULL,
	`snooze_until` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `home_feedback_idem_idx` ON `home_feedback` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `home_feedback_target_idx` ON `home_feedback` (`user_id`,`target_id`);--> statement-breakpoint
CREATE TABLE `home_milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`date` text NOT NULL,
	`yearly` integer DEFAULT true NOT NULL,
	`lead_days` integer DEFAULT 60 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `home_milestones_user_idx` ON `home_milestones` (`user_id`);