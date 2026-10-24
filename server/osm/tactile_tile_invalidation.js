"use strict";

const TILE_ZOOM = 15;
const memoryInvalidators = new Set();

// 緯度経度から、表示APIと同じWeb Mercator z15タイルIDを求める。
function coordinateToTileId(lngValue, latValue) {
  const lng = Number(lngValue);
  const lat = Number(latValue);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -85.051129 || lat > 85.051129) return null;
  const scale = 2 ** TILE_ZOOM;
  const x = Math.min(scale - 1, Math.max(0, Math.floor(((lng + 180) / 360) * scale)));
  const latitudeRadians = lat * Math.PI / 180;
  const y = Math.min(scale - 1, Math.max(0, Math.floor(
    (1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale
  )));
  return `${TILE_ZOOM}/${x}/${y}`;
}

function collectCoordinates(value, output) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value.coordinates)) {
    value.coordinates.forEach((coordinate) => {
      if (Array.isArray(coordinate) && coordinate.length >= 2 && !Array.isArray(coordinate[0])) {
        output.push([coordinate[0], coordinate[1]]);
      }
    });
  }
  if (Number.isFinite(Number(value.lng)) && Number.isFinite(Number(value.lat))) {
    output.push([value.lng, value.lat]);
  }
}

// 変更前後の両方を対象にし、追加・取消しのどちらでも古いタイルを残さない。
function collectAffectedTileIds(elements) {
  const coordinates = [];
  (Array.isArray(elements) ? elements : []).forEach((element) => {
    collectCoordinates(element && element.before, coordinates);
    collectCoordinates(element && element.after, coordinates);
  });
  return [...new Set(coordinates.map(([lng, lat]) => coordinateToTileId(lng, lat)).filter(Boolean))];
}

function registerTactileTileMemoryInvalidator(invalidator) {
  if (typeof invalidator !== "function") return () => {};
  memoryInvalidators.add(invalidator);
  return () => memoryInvalidators.delete(invalidator);
}

// OSM送信成功後にだけ呼び出す。メモリは同期的に、PostgreSQLは同じタイルIDを削除する。
// DB削除失敗を「OSM送信失敗」と誤表示しないため、結果として返し監査履歴へ残す。
async function invalidateTactileTiles({ pool, elements }) {
  const tileIds = collectAffectedTileIds(elements);
  memoryInvalidators.forEach((invalidate) => {
    try { invalidate(tileIds); } catch (_) { /* 別キャッシュの失敗を波及させない */ }
  });
  if (!tileIds.length) return { tileIds, memoryInvalidated: true, persistentInvalidated: true };
  if (!pool) return { tileIds, memoryInvalidated: true, persistentInvalidated: false, error: "database_unavailable" };
  try {
    const placeholders = tileIds.map(() => "?").join(",");
    await pool.query(`DELETE FROM osmcache.tactile_tiles WHERE tile_id IN (${placeholders})`, tileIds);
    return { tileIds, memoryInvalidated: true, persistentInvalidated: true };
  } catch (error) {
    return { tileIds, memoryInvalidated: true, persistentInvalidated: false, error: error.message || "tile_cache_invalidation_failed" };
  }
}

module.exports = {
  TILE_ZOOM,
  coordinateToTileId,
  collectAffectedTileIds,
  registerTactileTileMemoryInvalidator,
  invalidateTactileTiles,
};
