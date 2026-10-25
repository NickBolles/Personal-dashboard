CREATE TABLE `github_app_installations` (
	`id` integer PRIMARY KEY NOT NULL,
	`app_row_id` text NOT NULL,
	`account_login` text NOT NULL,
	`account_key` text NOT NULL,
	`account_type` text DEFAULT 'User' NOT NULL,
	`repository_selection` text DEFAULT 'selected' NOT NULL,
	`repos` text,
	`suspended` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`app_row_id`) REFERENCES `github_apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `github_app_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_key` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `github_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` integer NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`owner_login` text NOT NULL,
	`owner_type` text DEFAULT 'User' NOT NULL,
	`html_url` text,
	`client_id` text NOT NULL,
	`client_secret_cipher` text,
	`pem_cipher` text NOT NULL,
	`webhook_secret_cipher` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `work_links` ADD `checks_state` text;--> statement-breakpoint
ALTER TABLE `work_links` ADD `checks_at` text;