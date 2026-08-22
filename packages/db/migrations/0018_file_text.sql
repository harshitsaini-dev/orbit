CREATE TABLE `file_text` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`remote_id` text NOT NULL,
	`name` text NOT NULL,
	`virtual_path` text NOT NULL,
	`text` text NOT NULL,
	`confidence` real DEFAULT 0 NOT NULL,
	`scanned_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_text_uq` ON `file_text` (`account_id`,`remote_id`);
--> statement-breakpoint
CREATE INDEX `file_text_account_idx` ON `file_text` (`account_id`);
