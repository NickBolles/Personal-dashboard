CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`conversation_id` text,
	`item_id` text,
	`area_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'live' NOT NULL,
	`capture_json` text DEFAULT '{}' NOT NULL,
	`capture_log_json` text DEFAULT '[]' NOT NULL,
	`proposals_json` text DEFAULT '[]' NOT NULL,
	`triggered_by` text DEFAULT 'palette' NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_owner_status_idx` ON `workflow_runs` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow_idx` ON `workflow_runs` (`workflow_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_conversation_idx` ON `workflow_runs` (`conversation_id`);