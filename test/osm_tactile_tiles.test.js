"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  parseTileId,
  buildOverpassQueryForBbox,
  TACTILE_TILE_ZOOM,
  summarizeTileStatuses,
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
assert.deepStrictEqual(summarizeTileStatuses([{ status: "pending" }, { status: "pending" }]), {
  success: false, partial: false, pending: true, allPending: true, allFailed: false,
});
assert.deepStrictEqual(summarizeTileStatuses([{ status: "success" }, { status: "pending" }]), {
  success: true, partial: true, pending: true, allPending: false, allFailed: false,
});

const query = buildOverpassQueryForBbox(tile.bbox, {
  elementTypes: ["way", "node"],
  matchers: [{ key: "tactile_paving", values: ["yes", "both"] }],
});
assert.match(query, /\[bbox:[^\]]+\]/, "tile query must contain one bounded bbox");
assert.match(query, /way\["tactile_paving"/, "tile query must only request configured tactile objects");
assert.match(query, /out meta geom qt;/, "tile query must retain geometry and changeset metadata");
const shortQuery = buildOverpassQueryForBbox(tile.bbox, {
  elementTypes: ["way"],
  matchers: [{ key: "tactile_paving", values: ["yes"] }],
}, 4);
assert.match(shortQuery, /\[timeout:4\]/, "tile-specific QL budget must be encoded in the query");

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
assert.match(source, /TILE_HTTP_WAIT_MS = 1800/,
  "cache misses must not hold an HTTP response for the full upstream timeout");
assert.match(source, /TILE_OVERPASS_QUERY_TIMEOUT_SECONDS = 4/,
  "small z15 Overpass queries must have a four-second server budget");
assert.match(source, /TILE_OVERPASS_REQUEST_TIMEOUT_MS = 4500/,
  "each tile host attempt must stop after about 4.5 seconds");
assert.match(source, /buildOverpassQueryForBbox\(tile\.bbox, rules, TILE_OVERPASS_QUERY_TIMEOUT_SECONDS\)/,
  "the short query timeout must apply specifically to tile reads");
assert.match(source, /fetchOverpassFromHosts\(query, TILE_OVERPASS_REQUEST_TIMEOUT_MS\)/,
  "the short HTTP timeout must apply specifically to tile reads");
assert.match(source, /TILE_BACKGROUND_QUEUE_LIMIT = 8/,
  "cold tile work must have a bounded background queue");
assert.match(source, /tileInFlightRequests\.size >= TILE_BACKGROUND_QUEUE_LIMIT/,
  "queue saturation must return without starting another refresh");
assert.match(source, /const tileFailures = new Map\(\)/,
  "failed tiles must have a per-tile retry cooldown");
assert.match(source, /partial: successfulTileCount > 0 && unresolvedTileCount > 0/,
  "a batch must return successful tiles even when another tile fails");
assert.match(source, /allPending: pendingTileCount === responseTiles\.length/,
  "an all-pending batch must have an explicit contract");
assert.match(source, /allFailed: errorTileCount === responseTiles\.length/,
  "an all-error batch must be distinguishable from a valid empty tile");
assert.match(source, /status: "pending"[\s\S]{0,150}?features: \[\]/,
  "pending tiles must remain a transient response state");
assert.match(source, /status: "error"[\s\S]{0,150}?features: \[\]/,
  "upstream errors must remain error tiles instead of being persisted as empty tiles");
assert.match(source, /tileMemoryCache\.set\(tile\.id, entry\);[\s\S]{0,180}?ensureTileCacheSchema/,
  "runtime schema creation failures must retain the in-memory fallback");
assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS osmcache\.tactile_tiles/,
  "the persistent public tile cache must be reproducible from schema.sql");
assert.match(schemaSource, /CREATE TABLE IF NOT EXISTS osmcache\.local_tactile_tiles/,
  "the bounded local snapshot provider must be reproducible from schema.sql");
assert.match(source, /async function readLocalTileProvider\(tile\)/,
  "the API must support a bounded local snapshot provider");
assert.match(source, /const localEntry = await readLocalTileProvider\(tile\)/,
  "a dynamic-cache miss must consult the local provider before public Overpass");
assert.match(source, /source: "local_snapshot"/,
  "responses and safe logs must identify the local provider");
assert.match(source, /savedAt: Date\.now\(\)/,
  "a local snapshot must be fresh when served so clients do not refetch it forever");
assert.match(source, /snapshotImportedAt/,
  "snapshot import time must remain separate from the client cache fetch time");
assert.doesNotMatch(schemaSource, /osmcache\.tactile_tiles[\s\S]{0,900}?(memo|access_token|cookie)/i,
  "the public tile cache must not contain private notes or credentials");
assert.match(source, /tile_response tileId=\$\{result\.tile\.id\} source=\$\{result\.source\}/,
  "safe per-tile observation logs must identify source without raw coordinates");
assert.match(source, /responseMs=\$\{responseMs\} overpassWaitMs=\$\{result\.overpassWaitMs \|\| 0\} queueDepth=/,
  "safe logs must expose response, upstream wait and queue timing");

console.log("OSM tactile tile cache uses bounded z15 tiles, persistent public data, and partial responses");
