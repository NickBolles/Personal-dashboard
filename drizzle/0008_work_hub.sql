CREATE TABLE `dashboard_widgets` (
	`id` text PRIMARY KEY NOT NULL,
	`dashboard_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`size` text DEFAULT 'md' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`dashboard_id`) REFERENCES `dashboards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `dashboard_widgets_idx` ON `dashboard_widgets` (`dashboard_id`,`position`);--> statement-breakpoint
CREATE TABLE `dashboards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text DEFAULT 'Dashboard' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dashboards_user_id_unique` ON `dashboards` (`user_id`);--> statement-breakpoint
CREATE TABLE `work_events` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`reason` text,
	`actor` text NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_events_item_idx` ON `work_events` (`item_id`,`at`);--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`parent_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`next_action` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'captured' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`start_date` text,
	`target_date` text,
	`completed_at` text,
	`settled_kind` text,
	`settled_reason` text,
	`archived` integer DEFAULT false NOT NULL,
	`system_key` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_items_owner_idx` ON `work_items` (`user_id`,`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `work_items_system_idx` ON `work_items` (`user_id`,`system_key`);--> statement-breakpoint
CREATE TABLE `work_lineage` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`child_id` text NOT NULL,
	`parent_id` text,
	`relation` text NOT NULL,
	`note` text,
	`from_parent_id` text,
	`to_parent_id` text,
	`actor` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_lineage_child_idx` ON `work_lineage` (`child_id`);--> statement-breakpoint
CREATE INDEX `work_lineage_parent_idx` ON `work_lineage` (`parent_id`);--> statement-breakpoint
CREATE TABLE `work_links` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text,
	`url` text,
	`title` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'reference' NOT NULL,
	`external_state` text,
	`state_changed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_links_item_idx` ON `work_links` (`item_id`);--> statement-breakpoint
CREATE TABLE `work_packets` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`version` integer NOT NULL,
	`objective` text NOT NULL,
	`in_scope` text DEFAULT '' NOT NULL,
	`out_of_scope` text DEFAULT '' NOT NULL,
	`acceptance_criteria` text DEFAULT '' NOT NULL,
	`decisions` text DEFAULT '' NOT NULL,
	`open_questions` text DEFAULT '' NOT NULL,
	`context` text DEFAULT '' NOT NULL,
	`validation_required` integer DEFAULT true NOT NULL,
	`no_validation_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `work_packets_version_idx` ON `work_packets` (`item_id`,`version`);--> statement-breakpoint
CREATE TABLE `work_validations` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`metric` text NOT NULL,
	`comparator` text NOT NULL,
	`threshold` real NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`baseline` real,
	`observed` real,
	`evidence_url` text,
	`notes` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`waiver_reason` text,
	`due_date` text,
	`recorded_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `work_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `work_validations_item_idx` ON `work_validations` (`item_id`);