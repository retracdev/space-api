ALTER TABLE presence ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 0;
UPDATE presence SET is_anonymous = 1 WHERE display_name IN (
  'Anonymous Fox', 'Anonymous Panda', 'Anonymous Otter', 'Anonymous Penguin',
  'Anonymous Koala', 'Anonymous Dolphin', 'Anonymous Owl', 'Anonymous Bear'
);
