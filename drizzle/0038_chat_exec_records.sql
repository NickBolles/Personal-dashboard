CREATE TABLE `chat_exec_records` (
	`parent_session_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`child_session_id` text,
	`child_profile` text,
	`delegation_id` text,
	`subagent_id` text,
	`task_index` integer,
	`title` text NOT NULL,
	`state` text DEFAULT 'unknown' NOT NULL,
	`step` text,
	`summary` text,
	`error` text,
	`started_at` text,
	`ended_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`transcript_path` text,
	`links_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_exec_identity_idx` ON `chat_exec_records` (`parent_session_id`,`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `chat_exec_parent_idx` ON `chat_exec_records` (`parent_session_id`);--> statement-breakpoint
CREATE INDEX `chat_exec_child_idx` ON `chat_exec_records` (`child_session_id`);--> statement-breakpoint
ALTER TABLE `session_meta` ADD `parent_session_id` text;