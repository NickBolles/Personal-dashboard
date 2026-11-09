CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`seq` integer NOT NULL,
	`item_id` text NOT NULL,
	`run_id` text,
	`question` text NOT NULL,
	`choices_json` text DEFAULT '[]' NOT NULL,
	`recommended` text,
	`risk_json` text DEFAULT '[]' NOT NULL,
	`pack_json` text DEFAULT '{}' NOT NULL,
	`detail` text,
	`action_json` text,
	`default_choice` text,
	`expires_at` text,
	`state` text DEFAULT 'open' NOT NULL,
	`answered_choice` text,
	`answered_at` text,
	`answered_via` text,
	`deferred_until` text,
	`superseded_by` text,
	`raised_by` text NOT NULL,
	`asked_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `decisions_seq_idx` ON `decisions` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `decisions_item_idx` ON `decisions` (`user_id`,`item_id`,`state`);--> statement-breakpoint
CREATE INDEX `decisions_state_idx` ON `decisions` (`user_id`,`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `owner_markers` (
	`user_id` text NOT NULL,
	`surface` text NOT NULL,
	`last_looked_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `surface`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`via` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_events_run_idx` ON `run_events` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `run_events_user_idx` ON `run_events` (`user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `seq` integer;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `parent_run_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `pipeline_json` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `lock_json` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `interrupted_at` text;--> statement-breakpoint
CREATE INDEX `agent_runs_seq_idx` ON `agent_runs` (`user_id`,`seq`);--> statement-breakpoint
-- CW-2 back-fill: every open single-per-item decision becomes a D-n row (oldest first per owner); work_items.decision keeps its JSON (+ "ref") as the back-compat projection.
INSERT INTO `decisions` (`id`, `user_id`, `seq`, `item_id`, `question`, `choices_json`, `detail`, `action_json`, `risk_json`, `state`, `raised_by`, `asked_at`, `created_at`, `updated_at`)
SELECT 'dec_' || lower(hex(randomblob(12))), w.`user_id`,
  ROW_NUMBER() OVER (PARTITION BY w.`user_id` ORDER BY coalesce(nullif(json_extract(w.`decision`, '$.askedAt'), ''), w.`updated_at`), w.`id`),
  w.`id`, json_extract(w.`decision`, '$.question'),
  CASE WHEN json_type(w.`decision`, '$.choices') = 'array' THEN json_extract(w.`decision`, '$.choices') ELSE '[]' END,
  json_extract(w.`decision`, '$.detail'),
  CASE WHEN json_type(w.`decision`, '$.action') = 'object' THEN json_extract(w.`decision`, '$.action') ELSE NULL END,
  CASE WHEN json_type(w.`decision`, '$.action') = 'object' THEN '["device"]' WHEN json_extract(w.`decision`, '$.question') LIKE '@% proposes: %' THEN '["destructive"]' ELSE '[]' END,
  'open',
  coalesce((SELECT e.`via` FROM `work_events` e WHERE e.`item_id` = w.`id` AND e.`via` LIKE 'agent:%' AND e.`reason` = 'Needs your decision: ' || json_extract(w.`decision`, '$.question') ORDER BY e.`at` DESC LIMIT 1), 'person:' || w.`user_id`),
  coalesce(nullif(json_extract(w.`decision`, '$.askedAt'), ''), w.`updated_at`),
  coalesce(nullif(json_extract(w.`decision`, '$.askedAt'), ''), w.`updated_at`),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM `work_items` w
WHERE w.`decision` IS NOT NULL AND json_valid(w.`decision`) AND trim(coalesce(json_extract(w.`decision`, '$.question'), '')) <> '';
--> statement-breakpoint
UPDATE `work_items` SET `decision` = json_set(`decision`, '$.ref', (SELECT 'D-' || d.`seq` FROM `decisions` d WHERE d.`item_id` = `work_items`.`id` AND d.`state` = 'open'))
WHERE `id` IN (SELECT `item_id` FROM `decisions` WHERE `state` = 'open');
--> statement-breakpoint
UPDATE `agent_runs` SET `seq` = (SELECT count(*) FROM `agent_runs` a2 WHERE a2.`user_id` = `agent_runs`.`user_id` AND (a2.`started_at` < `agent_runs`.`started_at` OR (a2.`started_at` = `agent_runs`.`started_at` AND a2.`id` <= `agent_runs`.`id`)));
