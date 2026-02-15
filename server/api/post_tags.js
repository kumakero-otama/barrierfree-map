const { createDbPool } = require("../db");

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
    if (body.length > 1024 * 1024) {
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

function normalizeTagRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  const id = typeof row.code === "string" && row.code.trim() ? row.code.trim() : "";
  const label = typeof row.label_ja === "string" && row.label_ja.trim() ? row.label_ja.trim() : "";
  if (!id || !label) {
    return null;
  }
  return {
    id,
    label,
    dbId: row.id,
    sortOrder: row.sort_order,
  };
}

function buildBaseCode(label) {
  const normalized = label
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "tag";
}

async function codeExists(pool, code) {
  const [rows] = await pool.query(
    "SELECT 1 FROM roadinfo.road_info_tag WHERE code = ? LIMIT 1",
    [code]
  );
  return rows.length > 0;
}

async function buildUniqueCode(pool, label) {
  const base = buildBaseCode(label);
  if (!(await codeExists(pool, base))) {
    return base;
  }

  for (let i = 2; i <= 10000; i += 1) {
    const candidate = `${base}_${i}`;
    if (!(await codeExists(pool, candidate))) {
      return candidate;
    }
  }

  const fallback = `tag_${Date.now()}`;
  if (!(await codeExists(pool, fallback))) {
    return fallback;
  }
  throw new Error("tag_code_generation_failed");
}

async function fetchActiveTags(pool) {
  const [rows] = await pool.query(
    `SELECT id, code, label_ja, sort_order
     FROM roadinfo.road_info_tag
     WHERE is_active = true
     ORDER BY sort_order ASC, id ASC`
  );
  return rows.map(normalizeTagRow).filter(Boolean);
}

async function findTagByLabel(pool, label) {
  const [rows] = await pool.query(
    `SELECT id, code, label_ja, sort_order
     FROM roadinfo.road_info_tag
     WHERE label_ja = ? AND is_active = true
     ORDER BY id ASC
     LIMIT 1`,
    [label]
  );
  return normalizeTagRow(rows[0]);
}

async function createTag(pool, label) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [maxRows] = await conn.query(
      "SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order FROM roadinfo.road_info_tag"
    );
    const nextSortOrder = Number(maxRows[0] && maxRows[0].max_sort_order) + 1;
    const code = await buildUniqueCode(conn, label);

    // Compat wrapper treats INSERT results differently, so use CTE and SELECT to get the inserted row.
    const [rows] = await conn.query(
      `WITH inserted AS (
         INSERT INTO roadinfo.road_info_tag (code, label_ja, sort_order, is_active)
         VALUES (?, ?, ?, true)
         RETURNING id, code, label_ja, sort_order
       )
       SELECT id, code, label_ja, sort_order FROM inserted`,
      [code, label, nextSortOrder]
    );

    await conn.commit();
    return normalizeTagRow(rows[0]);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function createPostTagsHandler({ sendJson }) {
  const dbResult = createDbPool();
  const pool = dbResult.pool;
  const dbError = dbResult.error;

  if (dbError) {
    console.warn("[post_tags] db_init_failed:", dbError.message);
  } else if (!pool) {
    console.warn("[post_tags] db_pool_unavailable");
  }

  return function handlePostTags(req, res) {
    if (req.method === "GET") {
      if (!pool) {
        sendJson(res, 503, { error: "database_unavailable" });
        return;
      }

      fetchActiveTags(pool)
        .then((tags) => {
          sendJson(res, 200, {
            success: true,
            count: tags.length,
            tags,
          });
        })
        .catch((err) => {
          console.error("[post_tags] load_error:", err.message);
          sendJson(res, 500, { error: "post_tags_unavailable" });
        });
      return;
    }

    if (req.method === "POST") {
      if (!pool) {
        sendJson(res, 503, { error: "database_unavailable" });
        return;
      }

      parseJsonBody(req, async (parseErr, body) => {
        if (parseErr) {
          sendJson(res, 400, {
            error: parseErr.message === "payload_too_large" ? "payload_too_large" : "invalid_json",
          });
          return;
        }

        const label = typeof body.label === "string" ? body.label.trim() : "";
        if (!label) {
          sendJson(res, 400, { error: "invalid_label" });
          return;
        }

        try {
          const existing = await findTagByLabel(pool, label);
          if (existing) {
            const tags = await fetchActiveTags(pool);
            sendJson(res, 200, { success: true, created: false, tag: existing, count: tags.length });
            return;
          }

          const created = await createTag(pool, label);
          const tags = await fetchActiveTags(pool);
          sendJson(res, 201, { success: true, created: true, tag: created, count: tags.length });
        } catch (err) {
          console.error("[post_tags] save_error:", err.message);
          sendJson(res, 500, { error: "post_tags_save_failed" });
        }
      });
      return;
    }

    sendJson(res, 405, { error: "method_not_allowed" });
  };
}

module.exports = createPostTagsHandler;
