ALTER TABLE `audit_log` ADD `actor_email` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `account_id` text REFERENCES `accounts`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `summary` text;--> statement-breakpoint
CREATE INDEX `audit_account_idx` ON `audit_log` (`account_id`,`created_at`);
