CREATE SCHEMA IF NOT EXISTS osmchange;

CREATE TABLE IF NOT EXISTS osmchange.review_queue (
  review_id UUID PRIMARY KEY,
  record_id UUID NOT NULL UNIQUE,
  plan_id UUID NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK(source_type IN ('new_record','legacy_record')),
  source_record_id TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(review_status IN ('pending','approved','rejected','merge_failed','merged')),
  rejection_reason TEXT,
  reviewer_user_id BIGINT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE osmchange.review_queue ADD COLUMN IF NOT EXISTS admin_note TEXT;
ALTER TABLE osmchange.review_queue DROP CONSTRAINT IF EXISTS review_queue_review_status_check;
ALTER TABLE osmchange.review_queue ADD CONSTRAINT review_queue_review_status_check
  CHECK(review_status IN ('pending','held','approved','rejected','merge_failed','merged'));

CREATE TABLE IF NOT EXISTS osmchange.review_events (
  event_id BIGSERIAL PRIMARY KEY,
  review_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS osmchange.review_notifications (
  notification_id UUID PRIMARY KEY,
  review_id UUID NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sent','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS osm_review_status_idx
  ON osmchange.review_queue(review_status,created_at DESC);
