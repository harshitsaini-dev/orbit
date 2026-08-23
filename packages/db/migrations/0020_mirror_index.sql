ALTER TABLE `files_mirror` ADD `created_at` text;
--> statement-breakpoint
CREATE INDEX `files_name_idx` ON `files_mirror` (`account_id`,`name`);
--> statement-breakpoint
CREATE INDEX `files_created_idx` ON `files_mirror` (`created_at`);
--> statement-breakpoint
CREATE INDEX `files_parent_idx` ON `files_mirror` (`account_id`,`parent_remote_id`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `files_fts` USING fts5(`name`, content=`files_mirror`, content_rowid=`rowid`);
--> statement-breakpoint
INSERT INTO `files_fts`(`rowid`, `name`) SELECT `rowid`, `name` FROM `files_mirror`;
--> statement-breakpoint
CREATE TRIGGER `files_fts_insert` AFTER INSERT ON `files_mirror` BEGIN
	INSERT INTO `files_fts`(`rowid`, `name`) VALUES (new.`rowid`, new.`name`);
END;
--> statement-breakpoint
CREATE TRIGGER `files_fts_delete` AFTER DELETE ON `files_mirror` BEGIN
	INSERT INTO `files_fts`(`files_fts`, `rowid`, `name`) VALUES ('delete', old.`rowid`, old.`name`);
END;
--> statement-breakpoint
CREATE TRIGGER `files_fts_update` AFTER UPDATE ON `files_mirror` BEGIN
	INSERT INTO `files_fts`(`files_fts`, `rowid`, `name`) VALUES ('delete', old.`rowid`, old.`name`);
	INSERT INTO `files_fts`(`rowid`, `name`) VALUES (new.`rowid`, new.`name`);
END;
