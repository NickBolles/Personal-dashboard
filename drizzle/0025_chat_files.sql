CREATE TABLE `chat_files` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`kind` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`storage_key` text NOT NULL,
	`extracted_text` text,
	`text_status` text,
	`location_removed` integer DEFAULT false NOT NULL,
	`run_id` text,
	`sent_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_files_session_idx` ON `chat_files` (`session_id`);--> statement-breakpoint
CREATE INDEX `chat_files_user_idx` ON `chat_files` (`user_id`);