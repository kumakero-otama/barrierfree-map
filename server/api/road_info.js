const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createDbPool } = require("../db");
const { resolveAuthenticatedUserId } = require("../auth_user");
const { loadRoadInfoConfig } = require("../road_info_config");

const UPLOAD_ROOT = path.join(__dirname, "..", "..", "uploads", "road_info_media");
const COMPLETION_TAG_CODES = new Set(["complete", "completed", "done", "resolved", "inactive"]);

// JSONボディを受け取り、サイズ超過/JSON不正を共通処理する。
function parseJsonBody(req, callback) {
  let done = false;
  const finish = (err, payload) => {
    if (done) {
      return;
    }
    done = true;
    callback(err, payload);
  };

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 30 * 1024 * 1024) {
      finish(new Error("payload_too_large"));
      req.destroy();
    }
  });
  req.on("end", () => {
    if (!body) {
      finish(null, {});
      return;
    }
    try {
      finish(null, JSON.parse(body));
    } catch {
      finish(new Error("invalid_json"));
    }
  });
  req.on("error", (err) => {
    finish(err);
  });
}

// タグID配列を「空文字除外 + 重複排除」で正規化する。
function sanitizeTagIds(rawTagIds) {
  if (!Array.isArray(rawTagIds)) {
    return [];
  }
  const tags = rawTagIds
    .map((tagId) => (typeof tagId === "string" ? tagId.trim() : ""))
    .filter(Boolean);
  return [...new Set(tags)];
}

// point.status に保存できる値を正規化する（未指定はnull）。
function normalizePointStatus(rawStatus) {
  if (rawStatus == null) {
    return null;
  }
  if (typeof rawStatus !== "string") {
    return null;
  }
  const normalized = rawStatus.trim().toLowerCase();
  if (normalized === "active" || normalized === "inactive") {
    return normalized;
  }
  return null;
}

// 選択タグの中に「完了扱い」を含むか判定する。
async function hasCompletionTag(conn, tagIds) {
  if (!Array.isArray(tagIds) || tagIds.length < 1) {
    return false;
  }
  const placeholders = tagIds.map(() => "?").join(", ");
  const [rows] = await conn.query(
    `SELECT code, label_ja
     FROM roadinfo.road_info_tag
     WHERE id IN (${placeholders})`,
    tagIds
  );
  const safeRows = Array.isArray(rows) ? rows : [];
  return safeRows.some((row) => {
    const code = String(row && row.code ? row.code : "").trim().toLowerCase();
    const labelJa = String(row && row.label_ja ? row.label_ja : "").trim();
    return COMPLETION_TAG_CODES.has(code) || labelJa === "完了";
  });
}

// ラベル文字列から英数字ベースのコード候補を作る。
function buildBaseCode(label) {
  const normalized = String(label || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "tag";
}

// 指定コードが既存タグに存在するか確認する。
async function codeExists(conn, code) {
  const [rows] = await conn.query(
    "SELECT 1 FROM roadinfo.road_info_tag WHERE code = ? LIMIT 1",
    [code]
  );
  return Array.isArray(rows) && rows.length > 0;
}

// 重複しないタグコードを作る（base, base_2 ... の順に探索）。
async function buildUniqueCode(conn, label) {
  const base = buildBaseCode(label);
  if (!(await codeExists(conn, base))) {
    return base;
  }

  for (let i = 2; i <= 10000; i += 1) {
    const candidate = `${base}_${i}`;
    if (!(await codeExists(conn, candidate))) {
      return candidate;
    }
  }

  const fallback = `tag_${Date.now()}`;
  if (!(await codeExists(conn, fallback))) {
    return fallback;
  }
  throw new Error("tag_code_generation_failed");
}

// 指定タグコードを解決し、未登録タグは作成してtag_id配列を返す。
async function resolveOrCreateTagIds(conn, rawTagCodes) {
  const tagCodes = sanitizeTagIds(rawTagCodes);
  if (tagCodes.length < 1) {
    return { tagIds: [], createdTags: [] };
  }

  const placeholders = tagCodes.map(() => "?").join(", ");
  const [existingRows] = await conn.query(
    `SELECT id, code
     FROM roadinfo.road_info_tag
     WHERE code IN (${placeholders})`,
    tagCodes
  );

  const tagIdByCode = new Map(existingRows.map((row) => [row.code, row.id]));
  const missingCodes = tagCodes.filter((code) => !tagIdByCode.has(code));
  const createdTags = [];

  if (missingCodes.length > 0) {
    const [maxRows] = await conn.query(
      "SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order FROM roadinfo.road_info_tag"
    );
    let nextSortOrder = Number(maxRows[0] && maxRows[0].max_sort_order) || 0;

    for (const rawCode of missingCodes) {
      const code = /^[a-z0-9_]+$/.test(rawCode) ? rawCode : await buildUniqueCode(conn, rawCode);
      const labelJa = rawCode;
      nextSortOrder += 1;

      const [insertedRows] = await conn.query(
        `WITH inserted AS (
           INSERT INTO roadinfo.road_info_tag (code, label_ja, sort_order, is_active)
           VALUES (?, ?, ?, true)
           ON CONFLICT (code)
           DO UPDATE SET label_ja = roadinfo.road_info_tag.label_ja
           RETURNING id, code
         )
         SELECT id, code FROM inserted`,
        [code, labelJa, nextSortOrder]
      );

      const inserted = Array.isArray(insertedRows) ? insertedRows[0] : null;
      if (!inserted || !inserted.id || !inserted.code) {
        throw new Error("tag_insert_failed");
      }
      tagIdByCode.set(rawCode, inserted.id);
      createdTags.push(inserted.code);
    }
  }

  return {
    tagIds: tagCodes.map((code) => tagIdByCode.get(code)).filter(Boolean),
    createdTags,
  };
}

// data URL形式の画像を検証し、バイナリへ変換する。
function parseDataUrl(dataUrl, maxImageBytes) {
  if (typeof dataUrl !== "string") {
    throw new Error("invalid_image_data");
  }
  const match = dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error("invalid_image_data");
  }
  const mimeType = match[1].toLowerCase();
  if (!mimeType.startsWith("image/")) {
    throw new Error("invalid_image_type");
  }
  const binary = Buffer.from(match[2], "base64");
  if (!binary.length) {
    throw new Error("invalid_image_data");
  }
  if (binary.length > maxImageBytes) {
    throw new Error("image_too_large");
  }
  return { mimeType, binary };
}

// MIMEまたはファイル名から保存拡張子を決める。
function getExtension(name, mimeType) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  const extFromName = path.extname(name || "").replace(".", "").toLowerCase();
  if (extFromName && /^[a-z0-9]+$/.test(extFromName)) {
    return extFromName;
  }
  return "bin";
}

// 道情報画像の保存先ディレクトリを用意する。
async function ensureUploadDir() {
  await fs.promises.mkdir(UPLOAD_ROOT, { recursive: true });
}

// 1枚の画像を保存し、公開URLを返す。
async function saveImage(image, index, maxImageBytes) {
  const { mimeType, binary } = parseDataUrl(image && image.dataUrl, maxImageBytes);
  const ext = getExtension(image && image.name, mimeType);
  const fileName = `${Date.now()}_${index}_${crypto.randomBytes(6).toString("hex")}.${ext}`;
  const absPath = path.join(UPLOAD_ROOT, fileName);
  await fs.promises.writeFile(absPath, binary);
  return {
    absPath,
    url: `/uploads/road_info_media/${fileName}`,
  };
}

function createRoadInfoHandler({ sendJson }) {
  const dbResult = createDbPool();
  const pool = dbResult.pool;
  const dbError = dbResult.error;

  if (dbError) {
    console.warn("[road_info] db_init_failed:", dbError.message);
  } else if (!pool) {
    console.warn("[road_info] db_pool_unavailable");
  }

  // 一覧取得・詳細取得・新規投稿をまとめて扱うAPI。
  return function handleRoadInfo(req, res) {
    if (req.method === "GET") {
      if (!pool) {
        sendJson(res, 503, { error: "database_unavailable" });
        return;
      }

      // GETは pointId の有無で「詳細」か「地図用一覧」かを切り替える。
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pointId = Number(requestUrl.searchParams.get("pointId"));
      if (Number.isInteger(pointId) && pointId > 0) {
        pool.query(
          `SELECT id,
                  ST_Y(geom::geometry) AS lat,
                  ST_X(geom::geometry) AS lng,
                  status,
                  created_at
           FROM roadinfo.road_info_point
           WHERE id = ?
           LIMIT 1`,
          [pointId]
        )
          .then(async ([pointRows]) => {
            if (!Array.isArray(pointRows) || pointRows.length < 1) {
              sendJson(res, 404, { error: "not_found" });
              return;
            }

            const point = pointRows[0];
            // 詳細表示用にタグ・投稿・画像を別テーブルから組み立てる。
            const [tagRows] = await pool.query(
              `SELECT t.id, t.code, t.label_ja
               FROM roadinfo.road_info_point_tag pt
               JOIN roadinfo.road_info_tag t ON t.id = pt.tag_id
               WHERE pt.point_id = ? AND t.is_active = true
               ORDER BY t.sort_order ASC, t.id ASC`,
              [pointId]
            );

            const [noteRows] = await pool.query(
              `SELECT n.id,
                      n.body,
                      n.created_at,
                      n.created_by,
                      u.username AS created_by_username,
                      u.icon_url AS created_by_icon_url
               FROM roadinfo.road_info_note n
               LEFT JOIN login.users u ON u.user_id = n.created_by
               WHERE n.point_id = ? AND n.is_deleted = false
               ORDER BY created_at DESC, id DESC`,
              [pointId]
            );

            const noteIds = noteRows.map((row) => row.id);
            let mediaRows = [];
            if (noteIds.length > 0) {
              const placeholders = noteIds.map(() => "?").join(", ");
              const [rows] = await pool.query(
                `SELECT id, note_id, media_type, url, created_at
                 FROM roadinfo.road_info_media
                 WHERE is_deleted = false AND note_id IN (${placeholders})
                 ORDER BY created_at ASC, id ASC`,
                noteIds
              );
              mediaRows = rows;
            }

            const mediaByNoteId = new Map();
            mediaRows.forEach((row) => {
              const list = mediaByNoteId.get(row.note_id) || [];
              list.push({
                id: row.id,
                mediaType: row.media_type,
                url: row.url,
                createdAt: row.created_at,
              });
              mediaByNoteId.set(row.note_id, list);
            });

            sendJson(res, 200, {
              success: true,
              point: {
                id: point.id,
                lat: Number(point.lat),
                lng: Number(point.lng),
                status: point.status,
                createdAt: point.created_at,
                tags: tagRows.map((row) => ({
                  id: row.id,
                  code: row.code,
                  labelJa: row.label_ja,
                })),
                posts: noteRows.map((row) => ({
                  id: row.id,
                  body: row.body,
                  createdAt: row.created_at,
                  createdBy: row.created_by || null,
                  authorUsername: row.created_by_username || null,
                  authorIconUrl: row.created_by_icon_url || null,
                  media: mediaByNoteId.get(row.id) || [],
                })),
              },
            });
          })
          .catch((err) => {
            console.error("[road_info] detail_error:", err.message);
            sendJson(res, 500, { error: "road_info_detail_failed" });
          });
        return;
      }

      const centerLat = Number(requestUrl.searchParams.get("centerLat"));
      const centerLng = Number(requestUrl.searchParams.get("centerLng"));
      const radiusKmRaw = Number(requestUrl.searchParams.get("radiusKm"));
      const radiusKm = Number.isFinite(radiusKmRaw) ? radiusKmRaw : 10;
      const mineOnly = requestUrl.searchParams.get("mine") === "1";

      if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng) || Math.abs(centerLat) > 90 || Math.abs(centerLng) > 180) {
        sendJson(res, 400, { error: "invalid_coordinates" });
        return;
      }
      if (!Number.isFinite(radiusKm) || radiusKm <= 0) {
        sendJson(res, 400, { error: "invalid_radius" });
        return;
      }

      // 地図用一覧は中心点 + 半径でactiveポイントのみ返す。
      const radiusMeters = Math.min(radiusKm, 20) * 1000;
      (async () => {
        let currentUserId = null;
        if (mineOnly) {
          currentUserId = await resolveAuthenticatedUserId(req, pool);
          if (!currentUserId) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
        }

        const params = [centerLng, centerLat, radiusMeters];
        let query = `SELECT
                       id,
                       ST_Y(geom::geometry) AS lat,
                       ST_X(geom::geometry) AS lng,
                       created_by
                     FROM roadinfo.road_info_point
                     WHERE status = 'active'
                       AND ST_DWithin(
                         geom,
                         ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography,
                         ?
                       )`;
        if (mineOnly) {
          query += " AND created_by = ?";
          params.push(currentUserId);
        }
        query += " ORDER BY created_at DESC LIMIT 3000";

        return pool.query(query, params);
      })()
        .then((queryResult) => {
          if (!queryResult) {
            return;
          }
          const [rows] = queryResult;
          sendJson(res, 200, {
            success: true,
            count: rows.length,
            points: rows.map((row) => ({
              id: row.id,
              lat: Number(row.lat),
              lng: Number(row.lng),
              createdBy: row.created_by == null ? null : Number(row.created_by),
            })),
          });
        })
        .catch((err) => {
          console.error("[road_info] list_error:", err.message);
          sendJson(res, 500, { error: "road_info_list_failed" });
        });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!pool) {
      sendJson(res, 503, { error: "database_unavailable" });
      return;
    }

    // POSTは point + tag関連 + note + media を1トランザクションで保存する。
    parseJsonBody(req, async (parseErr, body) => {
      if (parseErr) {
        const code = parseErr.message === "payload_too_large" ? "payload_too_large" : "invalid_json";
        sendJson(res, 400, { error: code });
        return;
      }

      const pointIdFromBody = Number(body && body.pointId);
      const lat = Number(body && body.lat);
      const lng = Number(body && body.lng);
      const detail = typeof body?.detail === "string" ? body.detail.trim() : "";
      const images = Array.isArray(body?.images) ? body.images : [];
      const tagCodes = sanitizeTagIds(body?.tagIds);
      const statusRequested = normalizePointStatus(body?.status);
      const roadInfoConfig = loadRoadInfoConfig();
      const maxImageBytes = roadInfoConfig.imageMaxBytes;
      const hasExistingPointId = Number.isInteger(pointIdFromBody) && pointIdFromBody > 0;
      let userId = null;
      if (body && Object.prototype.hasOwnProperty.call(body, "status") && !statusRequested) {
        sendJson(res, 400, { error: "invalid_status" });
        return;
      }

      if (!hasExistingPointId) {
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
          sendJson(res, 400, { error: "invalid_coordinates" });
          return;
        }
      }

      try {
        userId = await resolveAuthenticatedUserId(req, pool);
        if (!userId) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        await ensureUploadDir();
      } catch (err) {
        console.error("[road_info] upload_dir_error:", err.message);
        sendJson(res, 500, { error: "upload_dir_failed" });
        return;
      }

      const savedFiles = [];
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        let pointId = null;
        if (hasExistingPointId) {
          const [pointRows] = await conn.query(
            `SELECT id
             FROM roadinfo.road_info_point
             WHERE id = ? AND status <> 'deleted'
             LIMIT 1`,
            [pointIdFromBody]
          );
          if (!Array.isArray(pointRows) || pointRows.length < 1) {
            throw new Error("point_not_found");
          }
          pointId = pointIdFromBody;
        } else {
          const [pointResult] = await conn.query(
            `INSERT INTO roadinfo.road_info_point (geom, status, created_by)
             VALUES (ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, 'active', ?)`,
            [lng, lat, userId]
          );
          pointId = pointResult.insertId;
          if (!pointId) {
            throw new Error("point_insert_failed");
          }

          await conn.query(
            `UPDATE login.users
             SET total_road_posts = COALESCE(total_road_posts, 0) + 1,
                 updated_at = NOW()
             WHERE user_id = ?`,
            [userId]
          );

        }

        const { tagIds: resolvedTagIds, createdTags } = await resolveOrCreateTagIds(conn, tagCodes);
        for (const tagId of resolvedTagIds) {
          await conn.query(
            `INSERT INTO roadinfo.road_info_point_tag (point_id, tag_id)
             VALUES (?, ?)
             ON CONFLICT (point_id, tag_id) DO NOTHING
             RETURNING point_id`,
            [pointId, tagId]
          );
        }
        const completionSelected = await hasCompletionTag(conn, resolvedTagIds);
        const nextStatus = completionSelected ? "inactive" : statusRequested;

        const [noteResult] = await conn.query(
          `INSERT INTO roadinfo.road_info_note (point_id, body, created_by, is_deleted)
           VALUES (?, ?, ?, false)`,
          [pointId, detail, userId]
        );
        const noteId = noteResult.insertId;
        if (!noteId) {
          throw new Error("note_insert_failed");
        }

        for (let i = 0; i < images.length; i += 1) {
          const saved = await saveImage(images[i], i + 1, maxImageBytes);
          savedFiles.push(saved.absPath);
          await conn.query(
            `INSERT INTO roadinfo.road_info_media (note_id, media_type, url, created_by, is_deleted)
             VALUES (?, 'image', ?, ?, false)`,
            [noteId, saved.url, userId]
          );
        }

        if (nextStatus) {
          await conn.query(
            `UPDATE roadinfo.road_info_point
             SET status = ?,
                 updated_at = NOW()
             WHERE id = ?`,
            [nextStatus, pointId]
          );
        } else {
          await conn.query(
            `UPDATE roadinfo.road_info_point
             SET updated_at = NOW()
             WHERE id = ?`,
            [pointId]
          );
        }

        await conn.commit();
        sendJson(res, 201, {
          success: true,
          pointId,
          noteId,
          status: nextStatus || null,
          tagsCount: resolvedTagIds.length,
          createdTags,
          mediaCount: images.length,
        });
      } catch (err) {
        await conn.rollback();
        for (const absPath of savedFiles) {
          try {
            await fs.promises.unlink(absPath);
          } catch {
            // ignore cleanup failure
          }
        }
        if (err.message === "point_not_found") {
          sendJson(res, 404, { error: "point_not_found" });
          return;
        }
        if (["invalid_image_data", "invalid_image_type", "image_too_large"].includes(err.message)) {
          sendJson(res, 400, { error: err.message });
          return;
        }
        console.error("[road_info] save_error:", err.message);
        sendJson(res, 500, { error: "road_info_save_failed" });
      } finally {
        conn.release();
      }
    });
  };
}

module.exports = createRoadInfoHandler;
