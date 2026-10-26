CREATE TABLE `conversation_index` (
	`user_id` text PRIMARY KEY NOT NULL,
	`sessions` text DEFAULT '[]' NOT NULL,
	`complete` integer DEFAULT false NOT NULL,
	`refreshed_at` text,
	`attempted_at` text,
	`last_error` text,
	`accessed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
