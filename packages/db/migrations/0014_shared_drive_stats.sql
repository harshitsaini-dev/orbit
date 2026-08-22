CREATE TABLE `shared_drive_stats` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`drive_id` text NOT NULL,
	`name` text NOT NULL,
	`size_bytes` real DEFAULT 0 NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`totals` text DEFAULT '[]' NOT NULL,
	`partial` integer DEFAULT false NOT NULL,
	`measured_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_drive_stats_uq` ON `shared_drive_stats` (`account_id`,`drive_id`);
