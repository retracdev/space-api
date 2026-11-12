CREATE TABLE presence (
  site TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (site, visitor_id)
);
CREATE INDEX presence_site_last_seen ON presence (site, last_seen);
CREATE INDEX presence_last_seen ON presence (last_seen);
