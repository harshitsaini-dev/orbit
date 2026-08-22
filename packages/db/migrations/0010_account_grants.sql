ALTER TABLE `users` ADD `last_seen_at` text;--> statement-breakpoint
CREATE TABLE `account_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`level` text DEFAULT 'read' NOT NULL,
	`granted_by` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_grant_uq` ON `account_grants` (`account_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `account_grant_user_idx` ON `account_grants` (`user_id`);
