"use strict";

const crypto = require("crypto");
const fs = require("fs");
const yaml = require("yaml");
const { Pool } = require("pg");

if (process.argv[2] !== "--production-read-only" || !process.argv[3] || process.argv[4] !== "--cutoff" || !process.argv[5]) {
  throw new Error("usage: node tools/export_legacy_reviews_readonly.js --production-read-only <output.json> --cutoff <ISO timestamp>");
}

const outputPath = process.argv[3];
const cutoff = new Date(process.argv[5]);
if (!Number.isFinite(cutoff.getTime())) throw new Error("invalid_cutoff");
const configPath = process.env.PRODUCTION_DB_CONFIG_PATH || "/home/otama/barrierfree-map/config.yaml";
const db = yaml.parse(fs.readFileSync(configPath, "utf8")).db;
const pool = new Pool({ host: db.host, port: db.port || 5432, user: db.user, password: db.password,
  database: db.database, max: 1, ssl: db.ssl ? { rejectUnauthorized: false } : undefined });

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await client.query(`SELECT s.session_id,s.started_at,s.ended_at,s.is_active,
      u.username,COALESCE(u.is_guest,false) is_guest,
      ST_AsGeoJSON(p.geom::geometry) path_geojson,COALESCE(ST_Length(p.geom),0) path_m,
      COALESCE((SELECT json_agg(json_build_object('lat',ST_Y(r.geom::geometry),'lng',ST_X(r.geom::geometry),
        'accuracy',r.accuracy,'ts',r.ts) ORDER BY r.ts,r.id) FROM tactile.gps_raw r WHERE r.session_id=s.session_id),'[]') raw_points
      FROM tactile.sessions s LEFT JOIN login.users u ON u.user_id=s.user_id
      LEFT JOIN tactile.session_paths p ON p.session_id=s.session_id
      WHERE s.started_at <= $1 ORDER BY s.started_at,s.session_id`, [cutoff.toISOString()]);
    await client.query("COMMIT");
    const records = rows.map((row) => ({
      sourceDigest: crypto.createHash("sha256").update(String(row.session_id)).digest("hex"),
      startedAt: row.started_at,
      endedAt: row.ended_at,
      isActive: Boolean(row.is_active),
      username: row.username || "旧記録ユーザー",
      isGuest: Boolean(row.is_guest),
      pathGeoJson: row.path_geojson || null,
      pathMeters: Number(row.path_m || 0),
      rawPoints: row.raw_points || [],
      accuracyAvailable: (row.raw_points || []).some((point) => point.accuracy != null),
    }));
    const payload = { format: "stepby-legacy-review-v1", exportedAt: new Date().toISOString(), cutoff: cutoff.toISOString(),
      productionWritten: false, osmSent: false, recordCount: records.length, records };
    fs.writeFileSync(outputPath, JSON.stringify(payload));
    console.log(JSON.stringify({ outputPath, recordCount: records.length,
      withPath: records.filter((r) => r.pathGeoJson).length, withoutPath: records.filter((r) => !r.pathGeoJson).length,
      guest: records.filter((r) => r.isGuest).length, productionWritten: false, osmSent: false }));
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
