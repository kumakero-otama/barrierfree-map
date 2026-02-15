const { createDbPool } = require("../db");

function createRecordsHandler({ sendJson }) {
  const dbResult = createDbPool();
  const pool = dbResult.pool;
  const dbError = dbResult.error;

  if (dbError) {
    console.warn("records_handler_db_init_failed", dbError.message);
  } else if (!pool) {
    console.warn("records_handler_no_pool");
  }

  // 保存済みの経路ライン（session_paths）を地図描画用に返す。
  return async function handleRecords(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    // DB接続がない場合
    if (!pool) {
      sendJson(res, 503, { error: "database_unavailable" });
      return;
    }

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const centerLat = Number(url.searchParams.get("centerLat"));
      const centerLng = Number(url.searchParams.get("centerLng"));
      const radiusKm = Number(url.searchParams.get("radiusKm"));

      // 基本は全経路を取得し、条件があれば範囲検索を追加する。
      let query = `
        SELECT
          session_id,
          source,
          created_at,
          ST_AsGeoJSON(geom) AS geom_geojson
        FROM tactile.session_paths
      `;
      const params = [];

      if (Number.isFinite(centerLat) && Number.isFinite(centerLng) && Number.isFinite(radiusKm) && radiusKm > 0) {
        query += `
          WHERE ST_DWithin(
            geom,
            ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
            ?
          )
        `;
        params.push(centerLng, centerLat, radiusKm * 1000);
      }

      query += " ORDER BY created_at DESC";

      const [paths] = await pool.query(query, params);

      sendJson(res, 200, {
        success: true,
        count: paths.length,
        paths: paths
      });
    } catch (err) {
      console.error("records_fetch_error", err.message);
      sendJson(res, 500, { error: "database_error", message: err.message });
    }
  };
}

module.exports = createRecordsHandler;
