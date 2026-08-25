ALTER TABLE osmchange.review_queue
  ADD COLUMN IF NOT EXISTS source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS osm_review_source_idx
  ON osmchange.review_queue(source_type,created_at DESC);
