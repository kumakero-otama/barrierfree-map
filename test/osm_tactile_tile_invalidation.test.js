"use strict";

const assert = require("assert");
const {
  coordinateToTileId,
  collectAffectedTileIds,
  registerTactileTileMemoryInvalidator,
  invalidateTactileTiles,
} = require("../server/osm/tactile_tile_invalidation");

assert.match(coordinateToTileId(139.7671, 35.6812), /^15\/\d+\/\d+$/);
assert.strictEqual(coordinateToTileId(999, 35), null);

const elements = [{
  before: { coordinates: [[139.76, 35.68], [139.761, 35.681]] },
  after: { coordinates: [[139.76, 35.68], [139.762, 35.682]] },
}, { after: { lng: 139.763, lat: 35.683 } }];
const affected = collectAffectedTileIds(elements);
assert(affected.length > 0, "変更前後の座標から対象タイルを抽出する");

let invalidatedInMemory = [];
const unregister = registerTactileTileMemoryInvalidator((tileIds) => { invalidatedInMemory = tileIds; });
const queries = [];
const pool = { query: async (sql, params) => { queries.push({ sql, params }); return [[], []]; } };

(async () => {
  const result = await invalidateTactileTiles({ pool, elements });
  assert.deepStrictEqual(invalidatedInMemory, affected);
  assert.strictEqual(result.persistentInvalidated, true);
  assert.match(queries[0].sql, /DELETE FROM osmcache\.tactile_tiles WHERE tile_id IN/);
  assert.deepStrictEqual(queries[0].params, affected);

  const fallback = await invalidateTactileTiles({
    pool: { query: async () => { throw new Error("ddl_missing"); } },
    elements,
  });
  assert.strictEqual(fallback.memoryInvalidated, true);
  assert.strictEqual(fallback.persistentInvalidated, false);
  unregister();
  console.log("OSM publish/revert success invalidates affected tactile tile caches without network access");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
