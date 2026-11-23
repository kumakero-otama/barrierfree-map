const { createDbPool } = require("../db");

function parseTargetDate(rawValue, now = new Date()) {
  if (rawValue == null || rawValue === "") {
    return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
    return null;
  }

  const parsed = new Date(`${rawValue}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const [year, month, day] = rawValue.split("-").map(Number);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return rawValue;
}

// DBのUTC日時は変更せず、日本時間の翌日0時をUTCの排他的上限に変換する。
function jstExclusiveEnd(targetDate) {
  return new Date(Date.parse(`${targetDate}T00:00:00+09:00`) + 24 * 60 * 60 * 1000).toISOString();
}

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
      const url = new URL(req.url, `http://${req.headers.host}`);
      const targetDate = parseTargetDate(url.searchParams.get("date"));
      if (!targetDate) {
        sendJson(res, 400, { error: "invalid_date" });
        return;
      }

      const [rows] = await pool.query(
        `SELECT
           (SELECT COUNT(*)
              FROM login.users
             WHERE is_active = true
               AND created_at < (?::timestamptz AT TIME ZONE 'UTC')) AS total_users,
           (SELECT COALESCE(SUM(ST_Length(sp.geom)), 0)
              FROM tactile.sessions s
              JOIN tactile.session_paths sp
                ON sp.session_id = s.session_id
              JOIN login.users u
                ON u.user_id = s.user_id
             WHERE s.is_active = true
               AND u.is_active = true
               AND s.started_at < (?::timestamptz AT TIME ZONE 'UTC')) AS total_tactile_length_meters,
           (SELECT COUNT(*)
              FROM roadinfo.road_info_point
             WHERE status IN ('active', 'hidden')
               AND created_at < ?::timestamptz) AS total_road_info_posts`,
        [jstExclusiveEnd(targetDate), jstExclusiveEnd(targetDate), jstExclusiveEnd(targetDate)]
      );

      const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : {};

      sendJson(res, 200, {
        success: true,
        targetDate,
        timeZone: "Asia/Tokyo",
        totalUsers: Number(first.total_users || 0),
        totalTactileLengthMeters: Math.round(Number(first.total_tactile_length_meters) || 0),
        totalRoadInfoPosts: Number(first.total_road_info_posts || 0),
      });
    } catch (err) {
      console.error("stats_fetch_error", err.message);
      sendJson(res, 500, { error: "database_error", message: err.message });
    }
  };
}

module.exports = createStatsHandler;
module.exports.parseTargetDate = parseTargetDate;
module.exports.jstExclusiveEnd = jstExclusiveEnd;
