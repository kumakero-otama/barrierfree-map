CREATE SCHEMA IF NOT EXISTS experiment;

CREATE TABLE IF NOT EXISTS tactile.way_snapshots (
  snapshot_id uuid PRIMARY KEY,
  record_id uuid NOT NULL,
  segment_order integer NOT NULL CHECK (segment_order >= 0),
  way_id bigint NOT NULL,
  way_version integer NOT NULL CHECK (way_version > 0),
  node_ids jsonb NOT NULL,
  full_coordinates jsonb NOT NULL,
  segment_from jsonb NOT NULL,
  segment_to jsonb NOT NULL,
  original_tags jsonb NOT NULL,
  relation_context jsonb NOT NULL DEFAULT '[]'::jsonb,
  tactile_side text CHECK (tactile_side IS NULL OR tactile_side IN ('left', 'right')),
  planned_tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'browser_osm_snapshot',
  captured_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (record_id, segment_order)
);

CREATE INDEX IF NOT EXISTS way_snapshots_record_idx ON tactile.way_snapshots(record_id);
CREATE INDEX IF NOT EXISTS way_snapshots_way_idx ON tactile.way_snapshots(way_id, way_version);

CREATE TABLE IF NOT EXISTS experiment.api_records (
  experiment_id uuid PRIMARY KEY,
  label text NOT NULL,
  payload jsonb NOT NULL,
  created_by bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS experiment.api_record_audit (
  event_id uuid PRIMARY KEY,
  experiment_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created', 'deleted')),
  actor_user_id bigint NOT NULL,
  payload_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_record_audit_experiment_idx
  ON experiment.api_record_audit(experiment_id, created_at);
