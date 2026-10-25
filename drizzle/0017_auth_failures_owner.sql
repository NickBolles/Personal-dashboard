CREATE TABLE `auth_failures` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`first_at` integer NOT NULL,
	`last_at` integer NOT NULL,
	`locked_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- Make ownership explicit: the oldest admin today (the person who claimed Jarvis) becomes the persisted owner.
INSERT OR IGNORE INTO `settings` (`key`, `value`) SELECT 'owner_user_id', json_quote(`id`) FROM `users` WHERE `role` = 'admin' ORDER BY `created_at` ASC LIMIT 1;
