const { createDbPool } = require("../db");

function createFittingDetailsHandler({ sendJson }) {
  const { pool, error } = createDbPool();
  return async function handleFittingDetails(req, res) {
    if (process.env.NODE_ENV !== "development") return sendJson(res, 404, { error: "not_found" });
    if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
    if (!pool) return sendJson(res, 503, { error: "database_unavailable", message: error && error.message });
    try {
      const [sessions] = await pool.query(
        `SELECT session_id,started_at,ended_at FROM tactile.sessions
         WHERE user_id=? ORDER BY started_at DESC LIMIT 1`, [req.authUserId]
      );
      if (!sessions[0]) return sendJson(res, 404, { error: "recording_not_found" });
      const session = sessions[0];
      const [points] = await pool.query(
        `WITH raw AS (
           SELECT row_number() OVER(ORDER BY ts,id) n,ts,geom,accuracy FROM tactile.gps_raw WHERE session_id=?
         ), matched AS (
           SELECT row_number() OVER(ORDER BY ts,id) n,geom,edge_id,confidence FROM tactile.gps_matched WHERE session_id=?
         )
         SELECT raw.n,raw.ts,ST_Y(raw.geom::geometry) raw_lat,ST_X(raw.geom::geometry) raw_lng,raw.accuracy,
                ST_Y(matched.geom::geometry) matched_lat,ST_X(matched.geom::geometry) matched_lng,
                matched.edge_id way_id,matched.confidence,
                CASE WHEN matched.geom IS NULL THEN NULL ELSE ST_Distance(raw.geom,matched.geom) END distance_m
         FROM raw LEFT JOIN matched USING(n) ORDER BY raw.n`, [session.session_id, session.session_id]
      );
      sendJson(res, 200, { success: true, session, points, osmSent: false });
    } catch (err) {
      console.error("[fitting_details] failed", err.message);
      sendJson(res, 500, { error: "fitting_details_failed" });
    }
  };
}
module.exports = createFittingDetailsHandler;
