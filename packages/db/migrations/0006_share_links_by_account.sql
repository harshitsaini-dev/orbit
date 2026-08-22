-- Share links were keyed on a row in files_mirror, which the sync engine fills
-- and which nothing writes to yet - so a link could never be created for a file
-- the owner was actually looking at. Keyed on the account and the provider's own
-- id instead, sharing works today and the mirror stays an optimisation.
--
-- Dropped rather than altered: the table has never held a row, because it could
-- not.
DROP TABLE IF EXISTS `share_links`;--> statement-breakpoint
CREATE TABLE `share_links` (
	`short_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`account_id` text NOT NULL,
	`remote_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size_bytes` real DEFAULT 0 NOT NULL,
	`permission` text DEFAULT 'download' NOT NULL,
	`password_hash` text,
	`expires_at` text,
	`access_count` integer DEFAULT 0 NOT NULL,
	`last_accessed_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `share_owner_idx` ON `share_links` (`owner_id`);--> statement-breakpoint
CREATE INDEX `share_target_idx` ON `share_links` (`account_id`,`remote_id`);
