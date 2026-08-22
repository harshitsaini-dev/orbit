-- Provider-to-provider moves, persisted because they outlive a request.
--
-- The free instance has 512MB of RAM, sleeps after fifteen minutes idle and
-- restarts on deploy, so a transfer of any size will be interrupted. Keeping
-- the position after every chunk is what lets one resume rather than start
-- again.
CREATE TABLE `transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`source_account_id` text NOT NULL,
	`source_remote_id` text NOT NULL,
	`target_account_id` text NOT NULL,
	`target_path` text DEFAULT '/' NOT NULL,
	`name` text NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size_bytes` real DEFAULT 0 NOT NULL,
	`transferred_bytes` real DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`delete_source` integer DEFAULT false NOT NULL,
	`upload_state` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `transfer_owner_idx` ON `transfers` (`owner_id`);--> statement-breakpoint
CREATE INDEX `transfer_state_idx` ON `transfers` (`state`);
