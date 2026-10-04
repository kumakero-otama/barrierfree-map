const { createHash } = require("crypto");
const { createDbPool } = require("../db");
const { resolveAuthenticatedUserId } = require("../auth_user");

const MAX_BODY_BYTES = 64 * 1024;
const MAX_ITEMS = 50;
const ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeItems(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEMS) return null;
  const unique = new Map();
  for (const raw of value) {
    const itemId = String(raw && raw.itemId || "").trim();
    const text = String(raw && raw.text || "").trim();
    if (!ITEM_ID_PATTERN.test(itemId) || !text || text.length > 1000) return null;
    unique.set(itemId, {
      itemId,
      text,
      contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
    });
  }
  return Array.from(unique.values());
}

function createChangelogViewsHandler({ sendJson, poolOverride, resolveUserId } = {}) {
  const dbResult = poolOverride ? { pool: poolOverride } : createDbPool();
  const pool = dbResult.pool;
  const resolveUser = resolveUserId || resolveAuthenticatedUserId;
  let schemaPromise = null;

  function ensureSchema() {
    if (!schemaPromise) {
      schemaPromise = pool.query(`
        CREATE TABLE IF NOT EXISTS login.changelog_item_views (
          user_id BIGINT NOT NULL REFERENCES login.users(user_id) ON DELETE CASCADE,
          item_id VARCHAR(128) NOT NULL,
          changelog_version VARCHAR(32) NOT NULL,
          language VARCHAR(12) NOT NULL,
          item_text TEXT NOT NULL,
          content_hash CHAR(64) NOT NULL,
          first_displayed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, item_id)
        )
      `).catch((error) => {
        schemaPromise = null;
        throw error;
      });
    }
    return schemaPromise;
  }

  return async function handleChangelogViews(req, res) {
    if (!pool) {
      sendJson(res, 503, { error: "database_unavailable" });
      return;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    try {
      await ensureSchema();
      const userId = await resolveUser(req, pool);
      if (!userId) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.method === "GET") {
        const [rows] = await pool.query(
          `SELECT item_id, changelog_version, language, content_hash, first_displayed_at
           FROM login.changelog_item_views
           WHERE user_id = ?
           ORDER BY first_displayed_at ASC`,
          [userId]
        );
        sendJson(res, 200, {
          items: (rows || []).map((row) => ({
            itemId: row.item_id,
            version: row.changelog_version,
            language: row.language,
            contentHash: row.content_hash,
            displayedAt: row.first_displayed_at,
          })),
        });
        return;
      }

      const body = await readJsonBody(req);
      const version = String(body.version || "").trim().slice(0, 32);
      const language = String(body.language || "ja").trim().slice(0, 12);
      const items = normalizeItems(body.items);
      if (!version || !items) {
        sendJson(res, 400, { error: "invalid_changelog_view" });
        return;
      }

      for (const item of items) {
        await pool.query(
          `INSERT INTO login.changelog_item_views
             (user_id, item_id, changelog_version, language, item_text, content_hash)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, item_id) DO NOTHING`,
          [userId, item.itemId, version, language, item.text, item.contentHash]
        );
      }
      sendJson(res, 200, { recorded: items.map((item) => item.itemId) });
    } catch (error) {
      const known = error && ["invalid_json", "payload_too_large"].includes(error.message);
      sendJson(res, known ? 400 : 500, { error: known ? error.message : "changelog_view_failed" });
    }
  };
}

module.exports = { createChangelogViewsHandler, normalizeItems };
