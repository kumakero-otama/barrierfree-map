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
      const [paths] = await pool.query(`
        SELECT
          session_id,
          source,
          created_at,
          ST_AsGeoJSON(geom) AS geom_geojson
        FROM session_paths
        ORDER BY created_at DESC
      `);

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
