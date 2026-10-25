"use strict";

// 事前抽出した点字ブロックタイルを、StepBy内の読取専用providerへ投入する。
// 既存の動的Overpassキャッシュとは別テーブルに保存し、全件検証後に
// 1トランザクションでsnapshotを差し替える。

const fs = require("fs");
const path = require("path");
const { createDbPool } = require("../server/db");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const inputArg = args.find((arg) => !arg.startsWith("--"));

if (!inputArg) {
  console.error("usage: node scripts/import_local_tactile_tiles.js <seed.json> [--apply]");
  process.exit(2);
}

const inputPath = path.resolve(inputArg);
const stat = fs.statSync(inputPath);
if (stat.size > 10 * 1024 * 1024) throw new Error("local_tactile_seed_too_large");
const bundle = JSON.parse(fs.readFileSync(inputPath, "utf8"));

function validateBundle(value) {
  if (!value || value.formatVersion !== 1 || typeof value.snapshotId !== "string" || !value.snapshotId) {
    throw new Error("invalid_local_tactile_seed_header");
  }
  if (typeof value.sourceUrl !== "string" || !value.sourceUrl.startsWith("https://")) {
    throw new Error("invalid_local_tactile_seed_source");
  }
  if (value.zoom !== 15 || !Array.isArray(value.tiles) || value.tiles.length === 0 || value.tiles.length > 5000) {
    throw new Error("invalid_local_tactile_seed_tiles");
  }
  const ids = new Set();
  for (const tile of value.tiles) {
    if (!tile || !/^15\/\d+\/\d+$/.test(String(tile.tileId)) || ids.has(tile.tileId)) {
      throw new Error("invalid_or_duplicate_local_tactile_tile");
    }
    ids.add(tile.tileId);
    if (tile.zoom !== 15 || !Number.isInteger(tile.tileX) || !Number.isInteger(tile.tileY)) {
      throw new Error("invalid_local_tactile_tile_coordinates");
    }
    if (!['success', 'empty'].includes(tile.status) || !Array.isArray(tile.features)) {
      throw new Error("invalid_local_tactile_tile_payload");
    }
    if ((tile.status === "empty") !== (tile.features.length === 0)) {
      throw new Error("inconsistent_local_tactile_tile_status");
    }
  }
}

validateBundle(bundle);
const featureCopies = bundle.tiles.reduce((sum, tile) => sum + tile.features.length, 0);
console.log(JSON.stringify({
  mode: apply ? "apply" : "validate_only",
  snapshotId: bundle.snapshotId,
  region: bundle.region || null,
  tiles: bundle.tiles.length,
  featureCopies,
  bytes: stat.size,
}));

if (!apply) process.exit(0);

(async () => {
  const { pool } = createDbPool();
  if (!pool) throw new Error("database_unavailable");
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("CREATE SCHEMA IF NOT EXISTS osmcache");
    await connection.query(`CREATE TABLE IF NOT EXISTS osmcache.local_tactile_tiles (
      tile_id TEXT PRIMARY KEY,
      zoom SMALLINT NOT NULL,
      tile_x INTEGER NOT NULL,
      tile_y INTEGER NOT NULL,
      snapshot_id TEXT NOT NULL,
      source_url TEXT NOT NULL,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL CHECK (status IN ('success','empty')),
      features JSONB NOT NULL DEFAULT '[]'::jsonb,
      feature_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    for (const tile of bundle.tiles) {
      await connection.query(
        `INSERT INTO osmcache.local_tactile_tiles
           (tile_id,zoom,tile_x,tile_y,snapshot_id,source_url,imported_at,status,features,feature_count,updated_at)
         VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,?,?::jsonb,?,CURRENT_TIMESTAMP)
         ON CONFLICT (tile_id) DO UPDATE SET
           zoom=EXCLUDED.zoom,tile_x=EXCLUDED.tile_x,tile_y=EXCLUDED.tile_y,
           snapshot_id=EXCLUDED.snapshot_id,source_url=EXCLUDED.source_url,
           imported_at=CURRENT_TIMESTAMP,status=EXCLUDED.status,
           features=EXCLUDED.features,feature_count=EXCLUDED.feature_count,
           updated_at=CURRENT_TIMESTAMP
         RETURNING tile_id`,
        [tile.tileId, tile.zoom, tile.tileX, tile.tileY, bundle.snapshotId,
          bundle.sourceUrl, tile.status, JSON.stringify(tile.features), tile.features.length]
      );
    }
    await connection.query(
      "DELETE FROM osmcache.local_tactile_tiles WHERE snapshot_id<>?",
      [bundle.snapshotId]
    );
    await connection.commit();
    console.log(JSON.stringify({ imported: true, snapshotId: bundle.snapshotId, tiles: bundle.tiles.length }));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    if (pool.pool && typeof pool.pool.end === "function") await pool.pool.end();
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
