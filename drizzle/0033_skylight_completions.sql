CREATE TABLE `source_completions` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`day` text NOT NULL,
	`title` text NOT NULL,
	`was_open` integer DEFAULT false NOT NULL,
	`completed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_completions_unique` ON `source_completions` (`source`,`source_id`,`day`);--> statement-breakpoint
CREATE INDEX `source_completions_at` ON `source_completions` (`completed_at`);