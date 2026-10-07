CREATE TABLE `invites` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_capabilities` (
	`user_id` text NOT NULL,
	`capability` text NOT NULL,
	`granted` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_capabilities_idx` ON `user_capabilities` (`user_id`,`capability`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_action_prefs` (
	`user_id` text DEFAULT '' NOT NULL,
	`action_id` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`hidden_until` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`user_id`, `action_id`)
);
--> statement-breakpoint
INSERT INTO `__new_action_prefs`("user_id", "action_id", "pinned", "hidden_until", "updated_at") SELECT COALESCE((SELECT "id" FROM `users` ORDER BY "created_at" LIMIT 1), ''), "action_id", "pinned", "hidden_until", "updated_at" FROM `action_prefs`;--> statement-breakpoint
DROP TABLE `action_prefs`;--> statement-breakpoint
ALTER TABLE `__new_action_prefs` RENAME TO `action_prefs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `session_meta` ADD `shared` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `username` text;--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `disabled_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);