-- Virtual folders: a PDF from S3, a spreadsheet from Drive and an image from
-- MEGA in one place, without moving or copying anything. The items are
-- references, so a collection is a view over files that stay where they are.
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`colour` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `collection_owner_idx` ON `collections` (`owner_id`);--> statement-breakpoint
CREATE TABLE `collection_items` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`account_id` text NOT NULL,
	`remote_id` text NOT NULL,
	`name` text NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size_bytes` real DEFAULT 0 NOT NULL,
	`is_folder` integer DEFAULT false NOT NULL,
	`virtual_path` text NOT NULL,
	`added_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `collection_item_uq` ON `collection_items` (`collection_id`,`account_id`,`remote_id`);--> statement-breakpoint
CREATE INDEX `collection_item_idx` ON `collection_items` (`collection_id`);
