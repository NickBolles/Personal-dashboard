CREATE TABLE `remembered_field_values` (
	`workflow_id` text NOT NULL,
	`field_id` text NOT NULL,
	`value_key` text NOT NULL,
	`value_json` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`used_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`workflow_id`, `field_id`, `value_key`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `remembered_field_values_recent_idx` ON `remembered_field_values` (`workflow_id`,`field_id`,`used_at`);--> statement-breakpoint
CREATE TABLE `saved_places` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`label` text NOT NULL,
	`address_text` text,
	`lat` real,
	`lng` real,
	`radius_m` integer DEFAULT 300 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_places_owner_idx` ON `saved_places` (`owner_id`);--> statement-breakpoint
CREATE TABLE `workflow_versions` (
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`created_by` text NOT NULL,
	`change_note` text,
	`definition_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`workflow_id`, `version`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`icon` text NOT NULL,
	`hue` text,
	`area_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_version` integer DEFAULT 1 NOT NULL,
	`definition_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflows_owner_slug_idx` ON `workflows` (`owner_id`,`slug`);--> statement-breakpoint
CREATE INDEX `workflows_owner_status_idx` ON `workflows` (`owner_id`,`status`);