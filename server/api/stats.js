const { createDbPool } = require("../db");

function createStatsHandler({ sendJson }) {
  const dbResult = createDbPool();
  const pool = dbResult.pool;
  const dbError = dbResult.error;

  if (dbError) {
    console.warn("stats_handler_db_init_failed", dbError.message);
  } else if (!pool) {
    console.warn("stats_handler_no_pool");
  }

  return async function handleStats(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (!pool) {
      sendJson(res, 503, { error: "database_unavailable" });
      return;
    }

    try {
      const [rows] = await pool.query(
        `SELECT
           (SELECT COUNT(*)
              FROM login.users
             WHERE is_active = true) AS total_users,
           (SELECT COALESCE(SUM(total_tactile_length), 0)
              FROM login.users
             WHERE is_active = true) AS total_tactile_length_km,
           (SELECT COUNT(*)
              FROM roadinfo.road_info_point
             WHERE status IN ('active', 'hidden')) AS total_road_info_posts`
      );

      const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : {};
      const totalTactileLengthKm = Number(first.total_tactile_length_km || 0);

      sendJson(res, 200, {
        success: true,
        totalUsers: Number(first.total_users || 0),
        totalTactileLengthMeters: Math.round(totalTactileLengthKm * 1000),
        totalRoadInfoPosts: Number(first.total_road_info_posts || 0),
      });
    } catch (err) {
      console.error("stats_fetch_error", err.message);
      sendJson(res, 500, { error: "database_error", message: err.message });
    }
  };
}

module.exports = createStatsHandler;
