CREATE TABLE `workout_requests` (
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`hash` text NOT NULL,
	`response` text NOT NULL,
	PRIMARY KEY(`user_id`, `request_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workout_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`version` integer NOT NULL,
	`document` text NOT NULL,
	`source` text,
	`source_id` text,
	`source_hash` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workout_owner_idx` ON `workout_sessions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workout_import_idx` ON `workout_sessions` (`user_id`,`source_id`);