"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  parseTileId,
  buildOverpassQueryForBbox,
  TACTILE_TILE_ZOOM,
} = require("../server/api/osm_tactile");

const source = fs.readFileSync(path.resolve(__dirname, "../server/api/osm_tactile.js"), "utf8");
const serverSource = fs.readFileSync(path.resolve(__dirname, "../server.js"), "utf8");
const schemaSource = fs.readFileSync(path.resolve(__dirname, "../database/schema.sql"), "utf8");

assert.strictEqual(TACTILE_TILE_ZOOM, 15);
const tile = parseTileId("15/28568/12947");
assert(tile, "valid z15 tile must be accepted");
assert(tile.bbox.west < tile.bbox.east && tile.bbox.south < tile.bbox.north,
  "tile bounds must have valid west/east and south/north order");
assert.strictEqual(parseTileId("14/1/1"), null, "unexpected zoom must be rejected");
assert.strictEqual(parseTileId("15/999999/1"), null, "out-of-range coordinates must be rejected");

const query = buildOverpassQueryForBbox(tile.bbox, {
  elementTypes: ["way", "node"],
  matchers: [{ key: "tactile_paving", values: ["yes", "both"] }],
});
assert.match(query, /\[bbox:[^\]]+\]/, "tile query must contain one bounded bbox");
assert.match(query, /way\["tactile_paving"/, "tile query must only request configured tactile objects");
assert.match(query, /out meta geom qt;/, "tile query must retain geometry and changeset metadata");

assert.match(serverSource, /\/api\/osm-tactile-tiles/,
  "the HTTP router must expose the tile endpoint");
assert.match(source, /MAX_TILES_PER_REQUEST = 9/,
  "tile request count must be bounded");
assert.match(source, /TILE_CACHE_FRESH_MS = 24 \* 60 \* 60 \* 1000/,
  "fresh tiles must avoid network reads for 24 hours");
assert.match(source, /TILE_CACHE_STALE_MS = 30 \* 24 \* 60 \* 60 \* 1000/,
  "stale tiles must remain displayable while refreshing");
assert.match(source, /TILE_CACHE_UNUSED_RETENTION_DAYS = 90/,
  "unused persistent tiles must be removed after 90 days");
assert.match(source, /last_accessed_at < CURRENT_TIMESTAMP - INTERVAL '\$\{TILE_CACHE_UNUSED_RETENTION_DAYS\} days'/,
  "cleanup must use the persisted last access timestamp");
assert.match(source, /if \(memory\) \{[\s\S]{0,500}?last_accessed_at=CURRENT_TIMESTAMP/,
  "memory hits must also refresh the persistent last access timestamp");
assert.match(source, /const tileInFlightRequests = new Map\(\)/,
  "duplicate reads of one tile must share one upstream request");
assert.match(source, /activeOverpassRequests < OVERPASS_MAX_CONCURRENCY/,
  "all Overpass reads must use a bounded server-wide queue");
assert.match(source, /partial: successfulTileCount > 0 && failedTileCount > 0/,
  "a batch must return successful tiles even when another tile fails");
assert.match(source, /allFailed: successfulTileCount === 0/,
  "an all-error batch must be distinguishable from a valid empty tile");
assert.match(source, /status: "error"[\s\S]{0,150}?features: \[\]/,
  "upstream errors must remain error tiles instead of being persisted as empty tiles");
assert.match(source, /tileMemoryCache\.set\(tile\.id, entry\);[\s\S]{0,180}?ensureTileCacheSchema/,
  "runtime schema creation failures must retain the in-memory fallback");
assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS osmcache\.tactile_tiles/,
  "the persistent public tile cache must be reproducible from schema.sql");
assert.doesNotMatch(schemaSource, /osmcache\.tactile_tiles[\s\S]{0,900}?(memo|access_token|cookie)/i,
  "the public tile cache must not contain private notes or credentials");

console.log("OSM tactile tile cache uses bounded z15 tiles, persistent public data, and partial responses");
