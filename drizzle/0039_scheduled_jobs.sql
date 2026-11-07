CREATE TABLE `scheduled_job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`slot` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`silent` integer DEFAULT false NOT NULL,
	`hermes_run_id` text,
	`session_id` text,
	`agent_run_id` text,
	`profile` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	`summary` text,
	`report` text,
	`error` text,
	`changes_json` text DEFAULT '[]' NOT NULL,
	`decisions_json` text DEFAULT '[]' NOT NULL,
	`refused_json` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `scheduled_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduled_job_runs_slot_idx` ON `scheduled_job_runs` (`job_id`,`slot`);--> statement-breakpoint
CREATE INDEX `scheduled_job_runs_user_at_idx` ON `scheduled_job_runs` (`user_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`area_id` text,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`prompt` text NOT NULL,
	`schedule_json` text NOT NULL,
	`tz` text NOT NULL,
	`overnight` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`template_key` text,
	`session_id` text,
	`last_run_at` text,
	`last_status` text DEFAULT 'never' NOT NULL,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scheduled_jobs_user_idx` ON `scheduled_jobs` (`user_id`);