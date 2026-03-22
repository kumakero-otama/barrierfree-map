const { createDbPool } = require("../db");
const { resolveAuthenticatedUserId } = require("../auth_user");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function createProStatusHandler({ sendJson }) {
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
      await pool.query("CREATE SCHEMA IF NOT EXISTS login");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS login.users (
          user_id BIGSERIAL PRIMARY KEY,
          username VARCHAR(50),
          icon_url TEXT,
          is_pro BOOLEAN DEFAULT FALSE,
          total_tactile_length NUMERIC(10,3) DEFAULT 0,
          total_road_posts INTEGER DEFAULT 0,
          total_hearts INTEGER DEFAULT 0,
          is_active BOOLEAN DEFAULT TRUE,
          email_verified BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_login_at TIMESTAMP
        )
      `);
      await pool.query(`
        ALTER TABLE login.users
        ADD COLUMN IF NOT EXISTS username VARCHAR(50)
      `);
      await pool.query(`
        ALTER TABLE login.users
        ADD COLUMN IF NOT EXISTS icon_url TEXT
      `);
      await pool.query(`
        ALTER TABLE login.users
        ADD COLUMN IF NOT EXISTS is_pro BOOLEAN DEFAULT FALSE
      `);
      await pool.query(`
        ALTER TABLE login.users
        ADD COLUMN IF NOT EXISTS total_tactile_length NUMERIC(10,3) DEFAULT 0
      `);
      await pool.query(`
        ALTER TABLE login.users
        ADD COLUMN IF NOT EXISTS total_road_posts INTEGER DEFAULT 0
      `);
      await pool.query(`
        ALTER TABLE login.users
        ADD COLUMN IF NOT EXISTS total_hearts INTEGER DEFAULT 0
      `);
      await pool.query(`
        ALTER TABLE login.users
        ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE
      `);
      await pool.query(`
        ALTER TABLE login.users
        ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE
      `);
      await pool.query(`
        ALTER TABLE login.users
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      `);
      await pool.query(`
        ALTER TABLE login.users
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      `);
      await pool.query(`
        ALTER TABLE login.users
        ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP
      `);
      initialized = true;
    })();

    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  }

  async function findCurrentUser(req) {
    if (!pool) {
      return { error: "db_unavailable" };
    }
    await ensureSchema();
    const userId = await resolveAuthenticatedUserId(req, pool);
    if (!userId) {
      return { error: "unauthorized" };
    }
    const [rows] = await pool.query(
      `SELECT user_id, is_pro
       FROM login.users
       WHERE user_id = ?
       LIMIT 1`,
      [userId]
    );
    if (!Array.isArray(rows) || rows.length < 1) {
      return { error: "user_not_found" };
    }
    return { user: rows[0] };
  }

  async function handleGet(req, res) {
    const result = await findCurrentUser(req);
    if (result.error === "db_unavailable") {
      sendJson(res, 503, { error: "db_unavailable" });
      return;
    }
    if (result.error === "unauthorized") {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (result.error === "user_not_found") {
      sendJson(res, 404, { error: "user_not_found" });
      return;
    }
    sendJson(res, 200, {
      userId: result.user.user_id,
      isPro: Boolean(result.user.is_pro),
    });
  }

  async function handlePut(req, res) {
    const result = await findCurrentUser(req);
    if (result.error === "db_unavailable") {
      sendJson(res, 503, { error: "db_unavailable" });
      return;
    }
    if (result.error === "unauthorized") {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (result.error === "user_not_found") {
      sendJson(res, 404, { error: "user_not_found" });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }

    if (typeof body.isPro !== "boolean") {
      sendJson(res, 400, { error: "invalid_is_pro" });
      return;
    }

    await pool.query(
      `UPDATE login.users
       SET is_pro = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`,
      [body.isPro, result.user.user_id]
    );

    sendJson(res, 200, {
      ok: true,
      userId: result.user.user_id,
      isPro: body.isPro,
    });
  }

  return async function handleProStatus(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/api/pro-status") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (req.method === "GET") {
      await handleGet(req, res);
      return;
    }
    if (req.method === "PUT") {
      await handlePut(req, res);
      return;
    }
    sendJson(res, 405, { error: "method_not_allowed" });
  };
}

module.exports = createProStatusHandler;
