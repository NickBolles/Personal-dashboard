CREATE TABLE `github_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`owner` text NOT NULL,
	`owner_key` text NOT NULL,
	`token_cipher` text NOT NULL,
	`token_last4` text NOT NULL,
	`repos` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`login` text,
	`last_test_at` text,
	`last_test_ok` integer,
	`last_test_result` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_connections_owner_idx` ON `github_connections` (`owner_key`);--> statement-breakpoint
CREATE TABLE `work_github_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`outcome` text DEFAULT '' NOT NULL,
	`received_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `work_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`connection_id` text,
	`title` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`url` text,
	`repo` text,
	`number` integer,
	`state` text DEFAULT 'open' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`dismissed_at` text,
	`accepted_at` text,
	`accepted_item_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_inbox_external_idx` ON `work_inbox` (`user_id`,`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `work_inbox_owner_idx` ON `work_inbox` (`user_id`,`state`);