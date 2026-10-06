CREATE TABLE `ai_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`reasoning` text,
	`run_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `ai_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_messages_session_idx` ON `ai_messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ai_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`backend` text NOT NULL,
	`model` text NOT NULL,
	`title` text DEFAULT 'New conversation' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
