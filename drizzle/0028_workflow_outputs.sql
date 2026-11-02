CREATE TABLE `workflow_reminders` (
	`workflow_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`day` integer DEFAULT 0 NOT NULL,
	`time` text DEFAULT '09:45' NOT NULL,
	`last_sent_date` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `summary_state` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `promoted_json` text DEFAULT '[]' NOT NULL;