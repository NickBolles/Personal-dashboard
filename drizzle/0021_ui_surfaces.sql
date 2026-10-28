CREATE TABLE `ui_surfaces` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`origin` text DEFAULT 'message' NOT NULL,
	`session_id` text,
	`message_key` text,
	`block_index` integer DEFAULT 0 NOT NULL,
	`report_id` text,
	`catalog` text NOT NULL,
	`spec_hash` text NOT NULL,
	`spec_json` text NOT NULL,
	`state_json` text DEFAULT '{}' NOT NULL,
	`applied_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ui_surfaces_key_idx` ON `ui_surfaces` (`user_id`,`session_id`,`message_key`,`block_index`);--> statement-breakpoint
CREATE INDEX `ui_surfaces_session_idx` ON `ui_surfaces` (`session_id`);