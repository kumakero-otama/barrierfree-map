const crypto = require("crypto");
const fs = require("fs");
const yaml = require("yaml");
const { Pool } = require("pg");

const sourceSessionId = process.argv[2];
if (!sourceSessionId || process.argv[3] !== "--confirm-copy-to-dev") {
  throw new Error("usage: node tools/import_production_record_readonly.js <session-id> --confirm-copy-to-dev");
}

function poolFrom(file) {
  const db = yaml.parse(fs.readFileSync(file, "utf8")).db;
  return new Pool({ host: db.host, port: db.port || 5432, user: db.user, password: db.password, database: db.database,
    max: 1, ssl: db.ssl ? { rejectUnauthorized: false } : undefined });
}

async function run() {
  const production = poolFrom(process.env.PRODUCTION_DB_CONFIG_PATH || "/home/otama/barrierfree-map/config.yaml");
  const development = poolFrom(process.env.DEVELOPMENT_DB_CONFIG_PATH || "/home/otama/barrierfree-map-dev/config.dev.yaml");
  const source = await production.connect();
  const target = await development.connect();
  const importedSessionId = crypto.randomUUID();
  try {
    await source.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const session = (await source.query("SELECT session_id,started_at,ended_at,is_active FROM tactile.sessions WHERE session_id=$1", [sourceSessionId])).rows[0];
    if (!session) throw new Error("production_session_not_found");
    const raw = (await source.query(`SELECT ts,ST_X(geom::geometry) lng,ST_Y(geom::geometry) lat,accuracy
      FROM tactile.gps_raw WHERE session_id=$1 ORDER BY ts,id`, [sourceSessionId])).rows;
    const matched = (await source.query(`SELECT ts,ST_X(geom::geometry) lng,ST_Y(geom::geometry) lat,edge_id,confidence
      FROM tactile.gps_matched WHERE session_id=$1 ORDER BY ts,id`, [sourceSessionId])).rows;
    const path = (await source.query(`SELECT ST_AsEWKT(geom) geom,source FROM tactile.session_paths WHERE session_id=$1 LIMIT 1`, [sourceSessionId])).rows[0] || null;
    const edges = (await source.query(`SELECT seq,edge_id FROM tactile.session_path_edges WHERE session_id=$1 ORDER BY seq`, [sourceSessionId])).rows;
    await source.query("COMMIT");
    if (raw.length < 5 || !path) throw new Error("production_record_not_suitable");

    await target.query("BEGIN");
    const devUser = (await target.query("SELECT user_id FROM login.users ORDER BY user_id LIMIT 1")).rows[0];
    if (!devUser) throw new Error("development_user_not_found");
    await target.query(`CREATE TABLE IF NOT EXISTS experiment.production_record_imports(
      import_id uuid PRIMARY KEY,development_session_id uuid UNIQUE NOT NULL,source_session_digest text NOT NULL,
      raw_point_count integer NOT NULL,matched_point_count integer NOT NULL,imported_at timestamptz NOT NULL DEFAULT NOW(),
      note text NOT NULL)`);
    const digest = crypto.createHash("sha256").update(String(sourceSessionId)).digest("hex");
    const existing = (await target.query("SELECT development_session_id FROM experiment.production_record_imports WHERE source_session_digest=$1", [digest])).rows[0];
    if (existing) { await target.query("ROLLBACK"); return { imported: false, existingSessionId: existing.development_session_id, rawPointCount: raw.length }; }
    await target.query(`INSERT INTO tactile.sessions(session_id,user_id,started_at,ended_at,is_active,memo)
      VALUES($1,$2,$3,$4,true,$5)`, [importedSessionId, devUser.user_id, session.started_at, session.ended_at, "本番DB読取専用コピー（OSM開発環境試験用）"]);
    for (const point of raw) await target.query(`INSERT INTO tactile.gps_raw(session_id,ts,geom,accuracy)
      VALUES($1,$2,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,$5)`, [importedSessionId, point.ts, point.lng, point.lat, point.accuracy]);
    for (const point of matched) await target.query(`INSERT INTO tactile.gps_matched(session_id,ts,geom,edge_id,confidence)
      VALUES($1,$2,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,$5,$6)`, [importedSessionId, point.ts, point.lng, point.lat, point.edge_id, point.confidence]);
    await target.query("INSERT INTO tactile.session_paths(session_id,geom,source) VALUES($1,ST_GeogFromText($2),$3)",
      [importedSessionId, path.geom, "production_readonly_copy"]);
    for (const edge of edges) await target.query("INSERT INTO tactile.session_path_edges(session_id,seq,edge_id) VALUES($1,$2,$3)",
      [importedSessionId, edge.seq, edge.edge_id]);
    await target.query(`INSERT INTO experiment.production_record_imports(import_id,development_session_id,source_session_digest,
      raw_point_count,matched_point_count,note) VALUES($1,$2,$3,$4,$5,$6)`, [crypto.randomUUID(), importedSessionId, digest,
      raw.length, matched.length, "Production DB was accessed in a READ ONLY transaction; identity was not copied; OSM was not contacted."]);
    await target.query("COMMIT");
    return { imported: true, developmentSessionId: importedSessionId, rawPointCount: raw.length, matchedPointCount: matched.length,
      edgeCount: edges.length, productionWritten: false, osmSent: false };
  } catch (error) {
    try { await source.query("ROLLBACK"); } catch {}
    try { await target.query("ROLLBACK"); } catch {}
    throw error;
  } finally { source.release(); target.release(); await production.end(); await development.end(); }
}

run().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
