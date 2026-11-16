ALTER TABLE presence ADD COLUMN status TEXT NOT NULL DEFAULT 'online'
  CONSTRAINT presence_status_valid CHECK (status IN ('online', 'idle'));
