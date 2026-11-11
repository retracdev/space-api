-- Reusable R2 image storage metadata and ownership. Object bytes live in the
-- SPACE_STORAGE R2 bucket; keys are server-generated from approved categories.
-- Per-category quotas are application configuration (src/storage.ts), not schema.
CREATE TABLE `storage_images` (
  `id` text PRIMARY KEY NOT NULL,
  `owner_id` text NOT NULL,
  `app_id` text NOT NULL,
  `category` text NOT NULL,
  `object_key` text NOT NULL UNIQUE,
  `mime_type` text NOT NULL,
  `size` integer NOT NULL,
  `width` integer NOT NULL,
  `height` integer NOT NULL,
  `status` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `storage_id_valid` CHECK (length(`id`) = 32 AND `id` NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT `storage_mime_valid` CHECK (`mime_type` IN ('image/png','image/jpeg','image/webp','image/gif')),
  CONSTRAINT `storage_size_valid` CHECK (`size` BETWEEN 1 AND 2097152),
  CONSTRAINT `storage_dimensions_valid` CHECK (`width` BETWEEN 1 AND 16384 AND `height` BETWEEN 1 AND 16384),
  CONSTRAINT `storage_status_valid` CHECK (`status` IN ('pending','ready','deleting'))
);
--> statement-breakpoint
CREATE INDEX `storage_images_owner` ON `storage_images` (`owner_id`,`category`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `storage_images_status` ON `storage_images` (`status`,`created_at`);
