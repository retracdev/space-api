CREATE TABLE `soundboard_notifications` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` text NOT NULL,
  `sound_name` text NOT NULL,
  `status` text NOT NULL,
  `reason` text,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `read_at` integer,
  CONSTRAINT `soundboard_notification_status_valid` CHECK (`status` IN ('added','denied'))
);
--> statement-breakpoint
CREATE INDEX `soundboard_notifications_user` ON `soundboard_notifications` (`user_id`,`read_at`,`created_at`,`id`);
