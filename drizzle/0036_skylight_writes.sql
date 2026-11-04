CREATE TABLE `skylight_writes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`via` text,
	`op` text NOT NULL,
	`target` text NOT NULL,
	`label` text NOT NULL,
	`payload` text NOT NULL,
	`inverse` text,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`undone_at` text,
	`undo_of` text
);
--> statement-breakpoint
CREATE INDEX `skylight_writes_user_at` ON `skylight_writes` (`user_id`,`at`);--> statement-breakpoint
CREATE INDEX `skylight_writes_at` ON `skylight_writes` (`at`);