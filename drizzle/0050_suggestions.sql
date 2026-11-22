CREATE TABLE `suggestion_topics` (
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`topic` text NOT NULL,
	`weight` integer DEFAULT 0 NOT NULL,
	`blocked` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`user_id`, `channel_id`, `topic`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`profile` text NOT NULL,
	`topic` text NOT NULL,
	`act` text NOT NULL,
	`item_id` text,
	`title` text NOT NULL,
	`why` text NOT NULL,
	`brief` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`run_id` text,
	`state` text DEFAULT 'open' NOT NULL,
	`hidden_until` text,
	`result_item_id` text,
	`result_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `suggestions_user_state_idx` ON `suggestions` (`user_id`,`state`);--> statement-breakpoint
CREATE INDEX `suggestions_channel_idx` ON `suggestions` (`channel_id`,`state`);