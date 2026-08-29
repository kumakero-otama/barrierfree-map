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
            THEN COALESCE(tag_info.all_tags, ARRAY[]::text[])
            ELSE COALESCE(tag_info.public_tags, ARRAY[]::text[])
          END AS tags,
          CASE WHEN s.user_id = ?
            THEN COALESCE(tag_info.all_tag_codes, ARRAY[]::text[])
            ELSE COALESCE(tag_info.public_tag_codes, ARRAY[]::text[])
          END AS tag_codes,
          osm_link.osm_status,
          CASE WHEN COALESCE(tag_info.has_private,FALSE) AND NOT COALESCE(tag_info.has_public,FALSE)
            THEN 'pro_private' ELSE 'stepby_tactile' END AS record_class
        FROM tactile.session_paths sp
        LEFT JOIN tactile.sessions s ON s.session_id = sp.session_id
        LEFT JOIN osmchange.record_links osm_link ON osm_link.record_id = sp.session_id
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

      // 旧版から移行し、管理者確認を終えた記録もStepByの緑線として返す。
      let legacyQuery = `SELECT q.record_id AS session_id,NULL::bigint AS user_id,'legacy_review' AS source,
        COALESCE(q.reviewed_at,q.created_at) AS created_at,q.source_metadata->>'pathGeoJson' AS geom_geojson,
        ARRAY['点字ブロック']::text[] AS tags,ARRAY['tactile_paving']::text[] AS tag_codes,
        l.osm_status,'stepby_tactile' AS record_class
        FROM osmchange.review_queue q JOIN osmchange.record_links l ON l.record_id=q.record_id
        WHERE q.source_type='legacy_record' AND q.review_status='merged' AND l.osm_status='merged'
          AND q.source_metadata->>'pathGeoJson' IS NOT NULL`;
      const legacyParams = [];
      if (Number.isFinite(centerLat) && Number.isFinite(centerLng) && Number.isFinite(radiusKm) && radiusKm > 0) {
        legacyQuery += ` AND ST_DWithin(ST_GeogFromText(ST_AsText(ST_GeomFromGeoJSON(q.source_metadata->>'pathGeoJson'))),
          ST_SetSRID(ST_MakePoint(?, ?),4326)::geography,?)`;
        legacyParams.push(centerLng, centerLat, radiusKm * 1000);
      }
      if (!mineOnly) {
        const [legacyPaths] = await pool.query(legacyQuery, legacyParams);
        paths.push(...legacyPaths);
      }

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
