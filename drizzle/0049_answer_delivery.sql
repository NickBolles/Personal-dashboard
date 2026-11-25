ALTER TABLE `decisions` ADD `delivery_state` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `delivery_session` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `deliver_after` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `delivered_at` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `delivery_error` text;--> statement-breakpoint
CREATE INDEX `decisions_delivery_idx` ON `decisions` (`delivery_state`,`deliver_after`);