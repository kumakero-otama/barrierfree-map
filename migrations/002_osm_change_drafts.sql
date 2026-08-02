CREATE SCHEMA IF NOT EXISTS osmchange;

-- This schema stores proposals and audit events only. No OSM network operation
-- is implemented by this migration or by the initial API.
CREATE TABLE IF NOT EXISTS osmchange.change_plans (
  plan_id UUID PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('merge', 'delete', 'revert')),
  created_by BIGINT NOT NULL,
  source_plan_id UUID,
  summary TEXT NOT NULL,
  elements JSONB NOT NULL,
  client_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS osmchange.audit_events (
  event_id BIGSERIAL PRIMARY KEY,
  plan_id UUID,
  event_type TEXT NOT NULL,
  actor_user_id BIGINT,
  request_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS osm_change_plans_created_idx ON osmchange.change_plans(created_at DESC);
CREATE INDEX IF NOT EXISTS osm_audit_plan_idx ON osmchange.audit_events(plan_id, event_id);

CREATE OR REPLACE FUNCTION osmchange.prevent_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OSM change history is append-only';
END $$;

DROP TRIGGER IF EXISTS osm_change_plans_append_only ON osmchange.change_plans;
CREATE TRIGGER osm_change_plans_append_only BEFORE UPDATE OR DELETE ON osmchange.change_plans
FOR EACH ROW EXECUTE FUNCTION osmchange.prevent_history_mutation();

DROP TRIGGER IF EXISTS osm_audit_events_append_only ON osmchange.audit_events;
CREATE TRIGGER osm_audit_events_append_only BEFORE UPDATE OR DELETE ON osmchange.audit_events
FOR EACH ROW EXECUTE FUNCTION osmchange.prevent_history_mutation();
