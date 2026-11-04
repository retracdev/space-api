-- Reviewed starting definitions; incompatible future scoring should use a new board ID.
INSERT INTO games (id, name, save_slots) VALUES
  ('chess', 'Chess', 5), ('pong', 'Pong', 5), ('2048', '2048', 5);
--> statement-breakpoint
INSERT INTO leaderboards (game_id, id, name, direction, score_type, min_score, max_score) VALUES
  ('pong', 'points', 'Points', 'desc', 'integer', 0, 1000000),
  ('pong', 'time', 'Completion time (seconds)', 'asc', 'number', 0.001, 86400),
  ('2048', 'score', 'Score', 'desc', 'integer', 0, 1000000000);
