ALTER TABLE `send_request` ADD `provider` text DEFAULT 'resend' NOT NULL;--> statement-breakpoint
ALTER TABLE `send_request` ADD `attempted_at` integer;