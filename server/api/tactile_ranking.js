const { createDbPool } = require("../db");

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 10;
const MAX_DAYS = 3650;
const MAX_LIMIT = 100;

function parsePositiveInt(rawValue, fallback) {
  if (rawValue == null || rawValue === "") {
    return fallback;
  }
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function createTactileRankingHandler({ sendJson }) {
  const dbResult = createDbPool();
  const pool = dbResult.pool;
  const dbError = dbResult.error;

  if (dbError) {
    console.warn("tactile_ranking_db_init_failed", dbError.message);
  } else if (!pool) {
    console.warn("tactile_ranking_no_pool");
  }

  return async function handleTactileRanking(req, res) {
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
      const days = parsePositiveInt(url.searchParams.get("days"), DEFAULT_DAYS);
      const limit = parsePositiveInt(url.searchParams.get("limit"), DEFAULT_LIMIT);

      if (days == null || days > MAX_DAYS) {
        sendJson(res, 400, { error: "invalid_days" });
        return;
      }
      if (limit == null || limit > MAX_LIMIT) {
        sendJson(res, 400, { error: "invalid_limit" });
        return;
      }

      const [rows] = await pool.query(
        `WITH aggregated AS (
           SELECT
             u.user_id,
             COALESCE(NULLIF(TRIM(u.username), ''), CASE WHEN u.is_guest THEN 'Guest' ELSE NULL END) AS username,
             u.icon_url,
             SUM(ST_Length(sp.geom))::double precision AS distance_meters
           FROM tactile.sessions s
           JOIN tactile.session_paths sp
             ON sp.session_id = s.session_id
           JOIN login.users u
             ON u.user_id = s.user_id
           WHERE s.is_active = true
             AND u.is_active = true
             AND s.started_at >= (CURRENT_TIMESTAMP - (? * INTERVAL '1 day'))
           GROUP BY u.user_id, u.username, u.icon_url, u.is_guest
         ),
         ranked AS (
           SELECT
             user_id,
             username,
             icon_url,
             distance_meters,
             RANK() OVER (ORDER BY distance_meters DESC) AS rank
           FROM aggregated
           WHERE distance_meters > 0
         )
         SELECT
           user_id,
           username,
           icon_url,
           distance_meters,
           rank
         FROM ranked
         ORDER BY rank ASC, distance_meters DESC, user_id ASC
         LIMIT ?`,
        [days, limit]
      );

      const ranking = rows.map((row) => ({
        userId: Number(row.user_id),
        username: row.username || null,
        rank: Number(row.rank),
        iconUrl: row.icon_url || null,
        distanceMeters: Math.round(Number(row.distance_meters) || 0),
      }));

      sendJson(res, 200, {
        success: true,
        periodDays: days,
        limit,
        count: ranking.length,
        ranking,
      });
    } catch (err) {
      console.error("tactile_ranking_fetch_error", err.message);
      sendJson(res, 500, { error: "database_error", message: err.message });
    }
  };
}

module.exports = createTactileRankingHandler;
