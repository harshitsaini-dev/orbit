CREATE TABLE `deletions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`remote_id` text NOT NULL,
	`deleted_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deletion_uq` ON `deletions` (`account_id`,`remote_id`);--> statement-breakpoint
CREATE INDEX `deletion_user_idx` ON `deletions` (`user_id`);
