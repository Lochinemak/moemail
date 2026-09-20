CREATE TABLE `message_attachment` (
  `id` text PRIMARY KEY NOT NULL,
  `message_id` text NOT NULL REFERENCES `message`(`id`) ON DELETE CASCADE,
  `content_id` text NOT NULL,
  `object_key` text NOT NULL,
  `content_type` text NOT NULL,
  `size` integer NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL
);
CREATE UNIQUE INDEX `message_attachment_object_key_unique` ON `message_attachment` (`object_key`);
CREATE UNIQUE INDEX `message_attachment_message_content_id_unique` ON `message_attachment` (`message_id`, `content_id`);
CREATE INDEX `message_attachment_message_id_idx` ON `message_attachment` (`message_id`);
