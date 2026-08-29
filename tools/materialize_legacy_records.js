"use strict";

const fs = require("fs");
const yaml = require("yaml");
const { Pool } = require("pg");

if (process.argv[2] !== "--confirm-new-db-only") {
  throw new Error("usage: node tools/materialize_legacy_records.js --confirm-new-db-only");
}

function createPool() {
  if (process.env.DATABASE_URL) return new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const config = yaml.parse(fs.readFileSync(process.env.DB_CONFIG_PATH || "config.dev.yaml", "utf8")).db;
  return new Pool({ host: config.host, port: config.port || 5432, user: config.user, password: config.password,
    database: config.database, max: 1, ssl: config.ssl ? { rejectUnauthorized: false } : undefined });
}

function validLineString(raw) {
  try {
    const geometry = JSON.parse(raw || "null");
    return geometry && geometry.type === "LineString" && Array.isArray(geometry.coordinates)
      && geometry.coordinates.length >= 2 && geometry.coordinates.every((point) => Array.isArray(point)
        && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])));
  } catch (_) { return false; }
}

async function findMappedUser(client, username, isGuest) {
  if (isGuest || !username || username === "旧記録ユーザー") return null;
  const { rows } = await client.query(`SELECT user_id FROM login.users
    WHERE is_active=TRUE AND is_guest=FALSE AND LOWER(TRIM(username))=LOWER(TRIM($1)) ORDER BY user_id`, [username]);
  return rows.length === 1 ? Number(rows[0].user_id) : null;
}

async function run() {
  const pool = createPool();
  const client = await pool.connect();
  let insertedSessions = 0, insertedPaths = 0, insertedRawPoints = 0, skippedExisting = 0;
  const mappedUsers = new Set();
  try {
    const migrationSql = fs.readFileSync(require("path").join(__dirname, "..", "migrations", "009_materialized_legacy_records.sql"), "utf8");
    await client.query("BEGIN");
    await client.query(migrationSql);
    const { rows: reviews } = await client.query(`SELECT review_id,record_id,source_record_id,source_metadata
      FROM osmchange.review_queue WHERE source_type='legacy_record' ORDER BY created_at,review_id`);
    if (reviews.length !== 328) throw new Error(`legacy_record_count_mismatch:${reviews.length}`);

    for (const review of reviews) {
      const metadata = review.source_metadata || {};
      const digest = String(metadata.sourceDigest || review.source_record_id || "");
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`invalid_source_digest:${review.review_id}`);
      const username = String(metadata.username || "旧記録ユーザー");
      const isGuest = Boolean(metadata.isGuest);
      const mappedUserId = await findMappedUser(client, username, isGuest);
      const sourceInsert = await client.query(`INSERT INTO migration.legacy_record_sources
        (source_digest,record_id,original_username,original_is_guest,mapped_user_id,source_metadata)
        VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(source_digest) DO NOTHING RETURNING source_digest`,
      [digest, review.record_id, username, isGuest, mappedUserId, JSON.stringify(metadata)]);
      if (!sourceInsert.rowCount) { skippedExisting += 1; continue; }

      await client.query(`INSERT INTO tactile.sessions(session_id,started_at,ended_at,user_id,memo,is_active)
        VALUES($1,$2,$3,$4,NULL,$5) ON CONFLICT(session_id) DO NOTHING`, [review.record_id,
        metadata.startedAt || metadata.endedAt || new Date(0).toISOString(), metadata.endedAt || null,
        mappedUserId, metadata.isActive !== false]);
      insertedSessions += 1;
      if (mappedUserId) mappedUsers.add(mappedUserId);

      const rawPoints = Array.isArray(metadata.rawPoints) ? metadata.rawPoints : [];
      for (let index = 0; index < rawPoints.length; index += 1) {
        const point = rawPoints[index];
        const lat = Number(point.lat), lng = Number(point.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`invalid_raw_point:${review.review_id}:${index}`);
        await client.query(`INSERT INTO tactile.gps_raw(session_id,ts,geom,accuracy)
          VALUES($1,$2,ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,$5)`, [review.record_id,
          point.ts || metadata.startedAt || new Date(0).toISOString(), lng, lat,
          point.accuracy == null || !Number.isFinite(Number(point.accuracy)) ? null : Number(point.accuracy)]);
        insertedRawPoints += 1;
      }

      if (validLineString(metadata.pathGeoJson)) {
        await client.query(`INSERT INTO tactile.session_paths(session_id,geom,source,created_at)
          VALUES($1,ST_SetSRID(ST_GeomFromGeoJSON($2),4326)::geography,'legacy_migration',$3)
          ON CONFLICT(session_id) DO NOTHING`, [review.record_id, metadata.pathGeoJson,
          metadata.startedAt || metadata.endedAt || new Date(0).toISOString()]);
        insertedPaths += 1;
      }
      await client.query(`INSERT INTO migration.legacy_record_events(source_digest,record_id,event_type,details)
        VALUES($1,$2,'materialized',$3::jsonb)`, [digest, review.record_id, JSON.stringify({
          reviewId: review.review_id, mappedUserId, username, isGuest,
          rawPointCount: rawPoints.length, pathImported: validLineString(metadata.pathGeoJson), osmSent: false,
        })]);
    }

    for (const userId of mappedUsers) {
      await client.query(`UPDATE login.users SET total_tactile_length=COALESCE((SELECT
        (COALESCE(SUM(ST_Length(sp.geom)),0)/1000.0)::numeric(10,3) FROM tactile.sessions s
        JOIN tactile.session_paths sp ON sp.session_id=s.session_id WHERE s.user_id=$1 AND s.is_active=TRUE),0),
        updated_at=NOW() WHERE user_id=$1`, [userId]);
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({ insertedSessions, insertedPaths, insertedRawPoints, skippedExisting,
      mappedUserIds: [...mappedUsers].sort((a, b) => a - b), sourceDatabaseWritten: false, osmSent: false }));
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

