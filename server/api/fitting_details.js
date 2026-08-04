const { createDbPool } = require("../db");
const { ensureRecordLinkSchema } = require("../osm/record_links");

function createFittingDetailsHandler({ sendJson }) {
  const { pool, error } = createDbPool();
  return async function handleFittingDetails(req, res) {
    if (process.env.NODE_ENV !== "development") return sendJson(res, 404, { error: "not_found" });
    if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
    if (!pool) return sendJson(res, 503, { error: "database_unavailable", message: error && error.message });
    try {
      await ensureRecordLinkSchema(pool);
      const [sessions] = await pool.query(
        `SELECT s.session_id,s.started_at,s.ended_at,
                l.merge_plan_id,l.merge_changeset_id,l.revert_plan_id,l.revert_changeset_id,l.osm_status
           FROM tactile.sessions s
           LEFT JOIN osmchange.record_links l ON l.record_id=s.session_id AND l.created_by=s.user_id
         WHERE s.user_id=? ORDER BY s.started_at DESC LIMIT 1`, [req.authUserId]
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
      sendJson(res, 200, {
        success: true,
        session,
        points,
        osm: {
          status: session.osm_status || "not_created",
          mergePlanId: session.merge_plan_id || null,
          mergeChangesetId: session.merge_changeset_id || null,
          revertPlanId: session.revert_plan_id || null,
          revertChangesetId: session.revert_changeset_id || null,
        },
        osmSent: ["merged", "revert_draft", "reverted"].includes(session.osm_status),
      });
    } catch (err) {
      console.error("[fitting_details] failed", err.message);
      sendJson(res, 500, { error: "fitting_details_failed" });
    }
  };
}
module.exports = createFittingDetailsHandler;
