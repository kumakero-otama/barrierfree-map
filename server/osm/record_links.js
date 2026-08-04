const initializedPools = new WeakSet();

async function ensureRecordLinkSchema(pool) {
  if (initializedPools.has(pool)) return;
  await pool.query("CREATE SCHEMA IF NOT EXISTS osmchange");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS osmchange.record_links (
      record_id UUID PRIMARY KEY,
      created_by BIGINT NOT NULL,
      merge_plan_id UUID NOT NULL UNIQUE,
      merge_changeset_id BIGINT UNIQUE,
      revert_plan_id UUID UNIQUE,
      revert_changeset_id BIGINT UNIQUE,
      osm_status TEXT NOT NULL DEFAULT 'draft'
        CHECK (osm_status IN ('draft','merged','revert_draft','reverted','failed','conflict')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE osmchange.record_links ALTER COLUMN record_id TYPE UUID USING record_id::uuid");
  await pool.query("CREATE INDEX IF NOT EXISTS osm_record_links_user_idx ON osmchange.record_links(created_by, created_at DESC)");
  await pool.query(`
    CREATE OR REPLACE FUNCTION osmchange.prevent_record_link_delete()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'OSM record links cannot be deleted';
    END $$
  `);
  await pool.query("DROP TRIGGER IF EXISTS osm_record_links_no_delete ON osmchange.record_links");
  await pool.query(`CREATE TRIGGER osm_record_links_no_delete BEFORE DELETE ON osmchange.record_links
    FOR EACH ROW EXECUTE FUNCTION osmchange.prevent_record_link_delete()`);
  initializedPools.add(pool);
}

module.exports = { ensureRecordLinkSchema };
