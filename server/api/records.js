const { createDbPool } = require("../db");
const { resolveAuthenticatedUserId } = require("../auth_user");
const { ensureProTagSchema } = require("../pro_record_policy");

// 保存済み経路一覧を返す API ハンドラを生成し、必要なら認証ユーザーで絞り込む。
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
      await ensureProTagSchema(pool);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const centerLat = Number(url.searchParams.get("centerLat"));
      const centerLng = Number(url.searchParams.get("centerLng"));
      const radiusKm = Number(url.searchParams.get("radiusKm"));
      const mineOnly = url.searchParams.get("mine") === "1";
      const currentUserId = await resolveAuthenticatedUserId(req, pool);
      if (!currentUserId) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      // 基本は全経路を取得し、検索条件があれば同じ SQL に WHERE を積み増していく。
      let query = `
        SELECT
          sp.session_id,
          s.user_id,
          source,
          sp.created_at,
          ST_AsGeoJSON(sp.geom) AS geom_geojson,
          CASE WHEN s.user_id = ?
            THEN COALESCE(tag_info.all_tags,
              CASE WHEN migrated.record_id IS NOT NULL THEN ARRAY['点字ブロック']::text[] ELSE ARRAY[]::text[] END)
            ELSE COALESCE(tag_info.public_tags,
              CASE WHEN migrated.record_id IS NOT NULL THEN ARRAY['点字ブロック']::text[] ELSE ARRAY[]::text[] END)
          END AS tags,
          CASE WHEN s.user_id = ?
            THEN COALESCE(tag_info.all_tag_codes,
              CASE WHEN migrated.record_id IS NOT NULL THEN ARRAY['tactile_paving']::text[] ELSE ARRAY[]::text[] END)
            ELSE COALESCE(tag_info.public_tag_codes,
              CASE WHEN migrated.record_id IS NOT NULL THEN ARRAY['tactile_paving']::text[] ELSE ARRAY[]::text[] END)
          END AS tag_codes,
          osm_link.osm_status,
          CASE WHEN COALESCE(tag_info.has_private,FALSE) AND NOT COALESCE(tag_info.has_public,FALSE)
            THEN 'pro_private' ELSE 'stepby_tactile' END AS record_class
        FROM tactile.session_paths sp
        LEFT JOIN tactile.sessions s ON s.session_id = sp.session_id
        LEFT JOIN osmchange.record_links osm_link ON osm_link.record_id = sp.session_id
        LEFT JOIN migration.legacy_record_sources migrated ON migrated.record_id = sp.session_id
        LEFT JOIN LATERAL (
          SELECT
            ARRAY_AGG(t.label_ja ORDER BY t.sort_order ASC, t.id ASC) AS all_tags,
            ARRAY_AGG(t.code ORDER BY t.sort_order ASC, t.id ASC) AS all_tag_codes,
            ARRAY_AGG(t.label_ja ORDER BY t.sort_order ASC, t.id ASC)
              FILTER (WHERE t.osm_exportable) AS public_tags,
            ARRAY_AGG(t.code ORDER BY t.sort_order ASC, t.id ASC)
              FILTER (WHERE t.osm_exportable) AS public_tag_codes,
            BOOL_OR(t.osm_exportable) AS has_public,
            BOOL_OR(NOT t.osm_exportable) AS has_private
          FROM tactile.session_tags st
          JOIN tactile.tags t ON t.id = st.tag_id
          WHERE st.session_id = sp.session_id
        ) AS tag_info ON TRUE
      `;
      const params = [currentUserId, currentUserId];
      const whereClauses = [];

      whereClauses.push("s.is_active = true");

      // 中心点と半径が揃っている場合だけ、PostGIS の距離検索を有効にする。
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
        // mine=1 のときは認証済みユーザーの経路だけへ制限する。
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
