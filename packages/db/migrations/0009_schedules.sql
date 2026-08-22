-- Recurring jobs: a sync, or a backup from one account to another.
--
-- Stored as a preset and a time rather than a cron string. A cron expression is
-- a good machine format and a poor thing to ask a person to write, and the four
-- shapes here cover what anyone actually schedules.
--
-- next_run_at is computed and stored rather than derived on the fly, so a tick
-- is one indexed read instead of parsing every schedule every minute.
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`action` text NOT NULL,
	`config` text NOT NULL,
	`every` text NOT NULL,
	`hour` integer DEFAULT 2 NOT NULL,
	`minute` integer DEFAULT 0 NOT NULL,
	`weekday` integer,
	`day_of_month` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` text NOT NULL,
	`last_run_at` text,
	`last_status` text,
	`last_message` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `schedule_owner_idx` ON `schedules` (`owner_id`);--> statement-breakpoint
CREATE INDEX `schedule_due_idx` ON `schedules` (`enabled`,`next_run_at`);
