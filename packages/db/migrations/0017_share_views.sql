CREATE TABLE `share_views` (
	`id` text PRIMARY KEY NOT NULL,
	`short_id` text NOT NULL,
	`kind` text NOT NULL,
	`device` text DEFAULT 'desktop' NOT NULL,
	`viewed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`short_id`) REFERENCES `share_links`(`short_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_view_link_idx` ON `share_views` (`short_id`,`viewed_at`);
