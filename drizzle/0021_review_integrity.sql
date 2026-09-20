CREATE TABLE `asset_deletion_queue` (
	`object_key` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `send_request` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`request_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text NOT NULL,
	`provider_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `send_request_user_key_unique` ON `send_request` (`user_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `send_request_usage_idx` ON `send_request` (`user_id`,`created_at`,`status`);--> statement-breakpoint
DROP INDEX IF EXISTS `email_address_lower_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `email_address_lower_idx` ON `email` (LOWER("address"));--> statement-breakpoint
CREATE UNIQUE INDEX `role_name_unique` ON `role` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_role_user_unique` ON `user_role` (`user_id`);
--> statement-breakpoint
-- Preserve known historical usage before switching quota reads to the ledger.
INSERT INTO send_request (id, user_id, request_key, payload_hash, status, created_at)
SELECT m.id, e.userId, 'legacy-' || m.id, '', 'sent', m.sent_at
FROM message m JOIN email e ON e.id = m.emailId
WHERE m.type = 'sent' AND e.userId IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER enqueue_deleted_attachment AFTER DELETE ON message_attachment
BEGIN
  INSERT OR IGNORE INTO asset_deletion_queue(object_key) VALUES (OLD.object_key);
END;
--> statement-breakpoint
-- Abort migration on existing multiple owners instead of silently choosing one.
CREATE TABLE review_integrity_guard (owners INTEGER CHECK (owners <= 1));
--> statement-breakpoint
INSERT INTO review_integrity_guard SELECT COUNT(*) FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE r.name = 'emperor';
--> statement-breakpoint
DROP TABLE review_integrity_guard;
--> statement-breakpoint
CREATE TRIGGER single_emperor_insert BEFORE INSERT ON user_role
WHEN (SELECT name FROM role WHERE id = NEW.role_id) = 'emperor'
  AND EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE r.name = 'emperor' AND ur.user_id != NEW.user_id)
BEGIN
  SELECT RAISE(ABORT, 'single_emperor');
END;
--> statement-breakpoint
CREATE TRIGGER single_emperor_update BEFORE UPDATE OF role_id, user_id ON user_role
WHEN (SELECT name FROM role WHERE id = NEW.role_id) = 'emperor'
  AND EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE r.name = 'emperor' AND ur.user_id != OLD.user_id)
BEGIN
  SELECT RAISE(ABORT, 'single_emperor');
END;
