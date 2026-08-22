CREATE TABLE `ignored_duplicates` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`group_key` text NOT NULL,
	`label` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ignored_duplicate_uq` ON `ignored_duplicates` (`user_id`,`group_key`);
