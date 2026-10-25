ALTER TABLE `work_items` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD `settings` text;--> statement-breakpoint
CREATE UNIQUE INDEX `work_items_session_idx` ON `work_items` (`user_id`,`session_id`);