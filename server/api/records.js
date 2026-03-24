const { createDbPool } = require("../db");
const { resolveAuthenticatedUserId } = require("../auth_user");

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
      const mineOnly = url.searchParams.get("mine") === "1";
      let currentUserId = null;
      if (mineOnly) {
        currentUserId = await resolveAuthenticatedUserId(req, pool);
        if (!currentUserId) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
      }

      // 基本は全経路を取得し、条件があれば範囲検索を追加する。
      let query = `
        SELECT
          sp.session_id,
          s.user_id,
          source,
          sp.created_at,
          ST_AsGeoJSON(sp.geom) AS geom_geojson,
          COALESCE(tag_info.tags, ARRAY[]::text[]) AS tags
        FROM tactile.session_paths sp
        LEFT JOIN tactile.sessions s ON s.session_id = sp.session_id
        LEFT JOIN (
          SELECT
            st.session_id,
            ARRAY_AGG(t.label_ja ORDER BY t.sort_order ASC, t.id ASC) AS tags
          FROM tactile.session_tags st
          JOIN tactile.tags t ON t.id = st.tag_id
          GROUP BY st.session_id
        ) AS tag_info ON tag_info.session_id = sp.session_id
      `;
      const params = [];
      const whereClauses = [];

      whereClauses.push("s.is_active = true");

      if (Number.isFinite(centerLat) && Number.isFinite(centerLng) && Number.isFinite(radiusKm) && radiusKm > 0) {
        whereClauses.push(`
          ST_DWithin(
            sp.geom,
            ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
            ?
          )
        `);
        params.push(centerLng, centerLat, radiusKm * 1000);
      }
      if (mineOnly) {
        whereClauses.push("s.user_id = ?");
        params.push(currentUserId);
      }

      if (whereClauses.length > 0) {
        query += ` WHERE ${whereClauses.join(" AND ")}`;
      }

      query += " ORDER BY sp.created_at DESC";

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
