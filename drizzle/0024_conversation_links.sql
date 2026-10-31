CREATE TABLE `conversation_links` (
	`session_id` text NOT NULL,
	`url` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`state` text,
	`pinned` integer DEFAULT false NOT NULL,
	`removed` integer DEFAULT false NOT NULL,
	`source` text,
	`first_seen_at` text,
	`resolved_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`session_id`, `url`)
);
--> statement-breakpoint
CREATE INDEX `conversation_links_session_idx` ON `conversation_links` (`session_id`);