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
      // すべてのセッションポイントを取得
      const [points] = await pool.query(`
        SELECT 
          sp.lat,
          sp.lng,
          sp.seq,
          sp.created_at,
          s.session_uuid,
          s.user_id,
          s.started_at,
          s.ended_at
        FROM session_points sp
        INNER JOIN sessions s ON sp.session_id = s.id
        ORDER BY s.started_at DESC, sp.seq ASC
      `);

      sendJson(res, 200, {
        success: true,
        count: points.length,
        points: points
      });
    } catch (err) {
      console.error("records_fetch_error", err.message);
      sendJson(res, 500, { error: "database_error", message: err.message });
    }
  };
}

module.exports = createRecordsHandler;
