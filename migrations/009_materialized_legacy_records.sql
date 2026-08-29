CREATE SCHEMA IF NOT EXISTS migration;

CREATE TABLE IF NOT EXISTS migration.legacy_record_sources (
  source_digest TEXT PRIMARY KEY,
  record_id UUID NOT NULL UNIQUE,
  original_username TEXT NOT NULL,
  original_is_guest BOOLEAN NOT NULL,
  mapped_user_id BIGINT,
  source_metadata JSONB NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS migration.legacy_record_events (
  event_id BIGSERIAL PRIMARY KEY,
  source_digest TEXT NOT NULL,
  record_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION migration.prevent_legacy_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Legacy migration history is append-only';
END $$;

DROP TRIGGER IF EXISTS legacy_record_events_append_only ON migration.legacy_record_events;
CREATE TRIGGER legacy_record_events_append_only
BEFORE UPDATE OR DELETE ON migration.legacy_record_events
FOR EACH ROW EXECUTE FUNCTION migration.prevent_legacy_event_mutation();

DROP TRIGGER IF EXISTS legacy_record_sources_immutable ON migration.legacy_record_sources;
CREATE TRIGGER legacy_record_sources_immutable
BEFORE UPDATE OR DELETE ON migration.legacy_record_sources
FOR EACH ROW EXECUTE FUNCTION migration.prevent_legacy_event_mutation();
