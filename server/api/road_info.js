const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createDbPool } = require("../db");
const { loadRoadInfoConfig } = require("../road_info_config");

const UPLOAD_ROOT = path.join(__dirname, "..", "..", "uploads", "road_info_media");

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

function sanitizeTagIds(rawTagIds) {
  if (!Array.isArray(rawTagIds)) {
    return [];
  }
  const tags = rawTagIds
    .map((tagId) => (typeof tagId === "string" ? tagId.trim() : ""))
    .filter(Boolean);
  return [...new Set(tags)];
}

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

async function ensureUploadDir() {
  await fs.promises.mkdir(UPLOAD_ROOT, { recursive: true });
}

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

  return function handleRoadInfo(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!pool) {
      sendJson(res, 503, { error: "database_unavailable" });
      return;
    }

    parseJsonBody(req, async (parseErr, body) => {
      if (parseErr) {
        const code = parseErr.message === "payload_too_large" ? "payload_too_large" : "invalid_json";
        sendJson(res, 400, { error: code });
        return;
      }

      const lat = Number(body && body.lat);
      const lng = Number(body && body.lng);
      const detail = typeof body?.detail === "string" ? body.detail.trim() : "";
      const images = Array.isArray(body?.images) ? body.images : [];
      const tagCodes = sanitizeTagIds(body?.tagIds);
      const roadInfoConfig = loadRoadInfoConfig();
      const maxImageBytes = roadInfoConfig.imageMaxBytes;

      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        sendJson(res, 400, { error: "invalid_coordinates" });
        return;
      }

      try {
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

        const [pointResult] = await conn.query(
          `INSERT INTO roadinfo.road_info_point (geom, status, created_by)
           VALUES (ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, 'active', NULL)`,
          [lng, lat]
        );
        const pointId = pointResult.insertId;
        if (!pointId) {
          throw new Error("point_insert_failed");
        }

        if (tagCodes.length > 0) {
          const placeholders = tagCodes.map(() => "?").join(", ");
          const [tagRows] = await conn.query(
            `SELECT id, code
             FROM roadinfo.road_info_tag
             WHERE is_active = true AND code IN (${placeholders})`,
            tagCodes
          );

          const tagIdByCode = new Map(tagRows.map((row) => [row.code, row.id]));
          const missingCodes = tagCodes.filter((code) => !tagIdByCode.has(code));
          if (missingCodes.length > 0) {
            throw new Error(`unknown_tags:${missingCodes.join(",")}`);
          }

          for (const code of tagCodes) {
            await conn.query(
              "INSERT INTO roadinfo.road_info_point_tag (point_id, tag_id) VALUES (?, ?) RETURNING point_id",
              [pointId, tagIdByCode.get(code)]
            );
          }
        }

        const [noteResult] = await conn.query(
          `INSERT INTO roadinfo.road_info_note (point_id, body, created_by, is_deleted)
           VALUES (?, ?, NULL, false)`,
          [pointId, detail]
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
             VALUES (?, 'image', ?, NULL, false)`,
            [noteId, saved.url]
          );
        }

        await conn.commit();
        sendJson(res, 201, {
          success: true,
          pointId,
          noteId,
          tagsCount: tagCodes.length,
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
        if (String(err.message || "").startsWith("unknown_tags:")) {
          sendJson(res, 400, { error: "unknown_tags" });
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
