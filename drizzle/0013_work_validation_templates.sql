CREATE TABLE `work_validation_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`metric` text NOT NULL,
	`comparator` text NOT NULL,
	`threshold` real NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`due_offset_days` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_validation_templates_owner_idx` ON `work_validation_templates` (`user_id`);