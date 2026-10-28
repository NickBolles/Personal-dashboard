ALTER TABLE `runs` ADD `hermes_profile` text;--> statement-breakpoint
ALTER TABLE `session_meta` ADD `hermes_profile` text;--> statement-breakpoint
-- ai_jobs.hermes_profile now means "the Hermes profile this job ran on". Every existing job ran on the default profile (it held the area agent-mode label before).
UPDATE `ai_jobs` SET `hermes_profile` = NULL;