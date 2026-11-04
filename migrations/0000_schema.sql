CREATE TABLE `games` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `save_slots` integer DEFAULT 5 NOT NULL,
  CONSTRAINT `slots_range` CHECK (`save_slots` BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE `leaderboards` (
  `game_id` text NOT NULL REFERENCES `games`(`id`),
  `id` text NOT NULL,
  `name` text NOT NULL,
  `direction` text NOT NULL CHECK (`direction` IN ('asc','desc')),
  `score_type` text NOT NULL CHECK (`score_type` IN ('integer','number')),
  `min_score` real NOT NULL,
  `max_score` real NOT NULL,
  PRIMARY KEY (`game_id`,`id`),
  CONSTRAINT `score_range` CHECK (`min_score` <= `max_score` AND `min_score` >= -9007199254740991 AND `max_score` <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `saves` (
  `user_id` text NOT NULL,
  `game_id` text NOT NULL REFERENCES `games`(`id`),
  `slot` integer NOT NULL CHECK (`slot` BETWEEN 0 AND 19),
  `data` text NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`user_id`,`game_id`,`slot`),
  CONSTRAINT `save_json` CHECK (json_valid(`data`) AND length(CAST(`data` AS BLOB)) <= 65536)
);
--> statement-breakpoint
CREATE TABLE `scores` (
  `user_id` text NOT NULL,
  `game_id` text NOT NULL,
  `board_id` text NOT NULL,
  `score` real NOT NULL CHECK (`score` BETWEEN -9007199254740991 AND 9007199254740991),
  `achieved_at` integer NOT NULL,
  PRIMARY KEY (`game_id`,`board_id`,`user_id`),
  FOREIGN KEY (`game_id`,`board_id`) REFERENCES `leaderboards`(`game_id`,`id`)
);
--> statement-breakpoint
CREATE INDEX `scores_rank_asc` ON `scores` (`game_id`,`board_id`,`score`,`user_id`);
--> statement-breakpoint
CREATE INDEX `scores_rank_desc` ON `scores` (`game_id`,`board_id`,`score` DESC,`user_id`);
--> statement-breakpoint
CREATE INDEX `scores_user` ON `scores` (`user_id`);
