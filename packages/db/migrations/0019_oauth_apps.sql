CREATE TABLE `oauth_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`website` text,
	`client_id` text NOT NULL,
	`client_secret_hash` text,
	`redirect_uris` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_app_client_uq` ON `oauth_apps` (`client_id`);
--> statement-breakpoint
CREATE INDEX `oauth_app_owner_idx` ON `oauth_apps` (`owner_id`);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`scopes` text NOT NULL,
	`challenge` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `oauth_apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_code_expiry_idx` ON `oauth_codes` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`refresh_hash` text,
	`access_hash` text,
	`access_expires_at` text,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `oauth_apps`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grant_uq` ON `oauth_grants` (`app_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `oauth_grant_access_idx` ON `oauth_grants` (`access_hash`);
--> statement-breakpoint
CREATE INDEX `oauth_grant_refresh_idx` ON `oauth_grants` (`refresh_hash`);
