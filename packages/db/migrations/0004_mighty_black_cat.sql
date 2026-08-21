ALTER TABLE `accounts` ADD `remote_account_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_remote_uq` ON `accounts` (`user_id`,`provider`,`remote_account_id`);