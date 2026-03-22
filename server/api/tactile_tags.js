const { createDbPool } = require("../db");
const { resolveAuthenticatedUserId } = require("../auth_user");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeTagRow(row) {
  if (!row) {
    return null;
  }
  return {
    id: Number(row.id),
    code: row.code,
    labelJa: row.label_ja,
    sortOrder: Number(row.sort_order || 0),
    isActive: Boolean(row.is_active),
  };
}

function normalizeSessionTagRow(row) {
  if (!row) {
    return null;
  }
  return {
    sessionId: row.session_id,
    tagId: Number(row.tag_id),
    tagCode: row.code || null,
    tagLabelJa: row.label_ja || null,
    sortOrder: row.sort_order == null ? null : Number(row.sort_order),
    isActive: row.is_active == null ? null : Boolean(row.is_active),
  };
}

function createTactileTagsHandler({ sendJson }) {
  const dbResult = createDbPool();
  const pool = dbResult.pool;
  let initialized = false;
  let initPromise = null;

  async function ensureSchema() {
    if (!pool) {
      return;
    }
    if (initialized) {
      return;
    }
    if (initPromise) {
      await initPromise;
      return;
    }
    initPromise = (async () => {
      await pool.query("CREATE SCHEMA IF NOT EXISTS tactile");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tactile.tags (
          id BIGSERIAL PRIMARY KEY,
          code TEXT UNIQUE NOT NULL,
          label_ja TEXT NOT NULL,
          sort_order INT NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tactile.sessions (
          session_id UUID PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES login.users(user_id),
          started_at TIMESTAMP NOT NULL,
          ended_at TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tactile.session_tags (
          session_id UUID NOT NULL,
          tag_id BIGINT NOT NULL,
          PRIMARY KEY (session_id, tag_id),
          CONSTRAINT fk_session_tags_session
            FOREIGN KEY (session_id)
            REFERENCES tactile.sessions (session_id)
            ON DELETE CASCADE,
          CONSTRAINT fk_session_tags_tag
            FOREIGN KEY (tag_id)
            REFERENCES tactile.tags (id)
            ON DELETE RESTRICT
        )
      `);
      initialized = true;
    })();

    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  }

  async function requireUserId(req, res) {
    if (!pool) {
      sendJson(res, 503, { error: "database_unavailable" });
      return null;
    }
    await ensureSchema();
    const userId = await resolveAuthenticatedUserId(req, pool);
    if (!userId) {
      sendJson(res, 401, { error: "unauthorized" });
      return null;
    }
    return userId;
  }

  async function listTactileTags(req, res, url) {
    await ensureSchema();
    const activeOnly = url.searchParams.get("activeOnly");
    const params = [];
    let whereSql = "";
    if (activeOnly === "1" || activeOnly === "true") {
      whereSql = "WHERE is_active = true";
    }
    const [rows] = await pool.query(
      `SELECT id, code, label_ja, sort_order, is_active
       FROM tactile.tags
       ${whereSql}
       ORDER BY sort_order ASC, id ASC`,
      params
    );
    sendJson(res, 200, {
      success: true,
      count: rows.length,
      tags: rows.map(normalizeTagRow).filter(Boolean),
    });
  }

  async function createTactileTag(req, res) {
    const userId = await requireUserId(req, res);
    if (!userId) {
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, {
        error: err.message === "payload_too_large" ? "payload_too_large" : "invalid_json",
      });
      return;
    }

    const code = typeof body.code === "string" ? body.code.trim() : "";
    const labelJa = typeof body.labelJa === "string" ? body.labelJa.trim() : "";
    const sortOrder = body.sortOrder == null ? 0 : Number(body.sortOrder);
    const isActive = body.isActive == null ? true : Boolean(body.isActive);

    if (!code) {
      sendJson(res, 400, { error: "invalid_code" });
      return;
    }
    if (!labelJa) {
      sendJson(res, 400, { error: "invalid_label_ja" });
      return;
    }
    if (!Number.isInteger(sortOrder)) {
      sendJson(res, 400, { error: "invalid_sort_order" });
      return;
    }

    try {
      const [existingRows] = await pool.query(
        `SELECT id, code, label_ja, sort_order, is_active
         FROM tactile.tags
         WHERE code = ?
         LIMIT 1`,
        [code]
      );
      if (existingRows.length > 0) {
        sendJson(res, 200, {
          success: true,
          created: false,
          requestedBy: userId,
          tag: normalizeTagRow(existingRows[0]),
        });
        return;
      }

      const [rows] = await pool.query(
        `WITH inserted AS (
           INSERT INTO tactile.tags (code, label_ja, sort_order, is_active)
           VALUES (?, ?, ?, ?)
           RETURNING id, code, label_ja, sort_order, is_active
         )
         SELECT id, code, label_ja, sort_order, is_active
         FROM inserted`,
        [code, labelJa, sortOrder, isActive]
      );

      sendJson(res, 201, {
        success: true,
        created: true,
        requestedBy: userId,
        tag: normalizeTagRow(rows[0]),
      });
    } catch (err) {
      console.error("[tactile_tags] create_tag_failed:", err.message);
      sendJson(res, 500, { error: "tactile_tag_create_failed" });
    }
  }

  async function listSessionTags(req, res, url) {
    const userId = await requireUserId(req, res);
    if (!userId) {
      return;
    }

    const sessionId = (url.searchParams.get("sessionId") || url.searchParams.get("sessionUuid") || "").trim();
    const params = [userId];
    let filterSql = "";
    if (sessionId) {
      filterSql = "AND st.session_id = ?";
      params.push(sessionId);
    }

    try {
      const [rows] = await pool.query(
        `SELECT st.session_id, st.tag_id, t.code, t.label_ja, t.sort_order, t.is_active
         FROM tactile.session_tags st
         JOIN tactile.sessions s ON s.session_id = st.session_id
         JOIN tactile.tags t ON t.id = st.tag_id
         WHERE s.user_id = ?
         ${filterSql}
         ORDER BY st.session_id ASC, t.sort_order ASC, t.id ASC`,
        params
      );
      sendJson(res, 200, {
        success: true,
        count: rows.length,
        sessionTags: rows.map(normalizeSessionTagRow).filter(Boolean),
      });
    } catch (err) {
      console.error("[tactile_tags] list_session_tags_failed:", err.message);
      sendJson(res, 500, { error: "session_tags_unavailable" });
    }
  }

  async function createSessionTag(req, res) {
    const userId = await requireUserId(req, res);
    if (!userId) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, {
        error: err.message === "payload_too_large" ? "payload_too_large" : "invalid_json",
      });
      return;
    }

    const sessionId = typeof body.sessionId === "string"
      ? body.sessionId.trim()
      : (typeof body.sessionUuid === "string" ? body.sessionUuid.trim() : "");
    const tagId = body.tagId == null ? null : Number(body.tagId);
    const tagCode = typeof body.tagCode === "string" ? body.tagCode.trim() : "";

    if (!sessionId) {
      sendJson(res, 400, { error: "missing_session_id" });
      return;
    }
    if (!Number.isInteger(tagId) && !tagCode) {
      sendJson(res, 400, { error: "missing_tag_id_or_tag_code" });
      return;
    }

    try {
      const [sessionRows] = await pool.query(
        `SELECT session_id
         FROM tactile.sessions
         WHERE session_id = ? AND user_id = ?
         LIMIT 1`,
        [sessionId, userId]
      );
      if (sessionRows.length < 1) {
        sendJson(res, 404, { error: "session_not_found_or_forbidden" });
        return;
      }

      const tagLookupSql = Number.isInteger(tagId)
        ? `SELECT id, code, label_ja, sort_order, is_active
           FROM tactile.tags
           WHERE id = ?
           LIMIT 1`
        : `SELECT id, code, label_ja, sort_order, is_active
           FROM tactile.tags
           WHERE code = ?
           LIMIT 1`;
      const tagLookupParam = Number.isInteger(tagId) ? tagId : tagCode;
      const [tagRows] = await pool.query(tagLookupSql, [tagLookupParam]);
      if (tagRows.length < 1) {
        sendJson(res, 404, { error: "tag_not_found" });
        return;
      }

      const targetTag = tagRows[0];
      const [existingRows] = await pool.query(
        `SELECT st.session_id, st.tag_id, t.code, t.label_ja, t.sort_order, t.is_active
         FROM tactile.session_tags st
         JOIN tactile.tags t ON t.id = st.tag_id
         WHERE st.session_id = ? AND st.tag_id = ?
         LIMIT 1`,
        [sessionId, targetTag.id]
      );
      if (existingRows.length > 0) {
        sendJson(res, 200, {
          success: true,
          created: false,
          sessionTag: normalizeSessionTagRow(existingRows[0]),
        });
        return;
      }

      const [rows] = await pool.query(
        `WITH inserted AS (
           INSERT INTO tactile.session_tags (session_id, tag_id)
           VALUES (?, ?)
           RETURNING session_id, tag_id
         )
         SELECT i.session_id, i.tag_id, t.code, t.label_ja, t.sort_order, t.is_active
         FROM inserted i
         JOIN tactile.tags t ON t.id = i.tag_id`,
        [sessionId, targetTag.id]
      );

      sendJson(res, 201, {
        success: true,
        created: true,
        sessionTag: normalizeSessionTagRow(rows[0]),
      });
    } catch (err) {
      console.error("[tactile_tags] create_session_tag_failed:", err.message);
      sendJson(res, 500, { error: "session_tag_create_failed" });
    }
  }

  return async function handleTactileTags(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (!pool) {
      sendJson(res, 503, { error: "database_unavailable" });
      return;
    }

    try {
      if (url.pathname === "/api/tactile-tags") {
        if (req.method === "GET") {
          await listTactileTags(req, res, url);
          return;
        }
        if (req.method === "POST") {
          await createTactileTag(req, res);
          return;
        }
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }

      if (url.pathname === "/api/session-tags") {
        if (req.method === "GET") {
          await listSessionTags(req, res, url);
          return;
        }
        if (req.method === "POST") {
          await createSessionTag(req, res);
          return;
        }
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      console.error("[tactile_tags] unhandled_error:", err.message);
      sendJson(res, 500, { error: "tactile_tags_unavailable" });
    }
  };
}

module.exports = createTactileTagsHandler;
