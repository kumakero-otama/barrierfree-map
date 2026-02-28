const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { OAuth2Client } = require("google-auth-library");
const { createDbPool } = require("../db");

const SESSION_COOKIE_NAME = "session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days
const MAX_ICON_BYTES = 5 * 1024 * 1024; // 5MB
const USER_ICON_DIR = path.join(__dirname, "..", "..", "uploads", "user_icons");

function parseCookies(rawCookieHeader) {
  const cookieHeader = rawCookieHeader || "";
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) {
        return acc;
      }
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function createSessionCookie(sessionId, { secure = false, maxAge = SESSION_MAX_AGE_SECONDS } = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function createGoogleAuthHandler({ sendJson, GOOGLE_CLIENT_ID }) {
  const dbResult = createDbPool();
  const pool = dbResult.pool;

  const client = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
  const memoryStore = {
    usersBySub: new Map(),
    sessions: new Map(),
    nextUserId: 1,
  };
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
          user_id SERIAL PRIMARY KEY,
          username VARCHAR(50),
          icon_url TEXT,
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
        CREATE TABLE IF NOT EXISTS login.user_auth_providers (
          auth_id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES login.users(user_id) ON DELETE CASCADE,
          provider VARCHAR(20) NOT NULL CHECK (provider IN ('email','google')),
          provider_user_id TEXT,
          email VARCHAR(255),
          password_hash TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT chk_uap_fields_by_provider CHECK (
            (provider='email' AND email IS NOT NULL AND password_hash IS NOT NULL AND provider_user_id IS NULL)
            OR
            (provider='google' AND provider_user_id IS NOT NULL AND password_hash IS NULL)
          )
        )
      `);

      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uix_uap_email_only
        ON login.user_auth_providers (email)
        WHERE provider = 'email'
      `);

      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uix_uap_google_sub
        ON login.user_auth_providers (provider_user_id)
        WHERE provider = 'google'
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS login.user_sessions (
          session_id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES login.users(user_id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP NOT NULL
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS ix_user_sessions_user_id
        ON login.user_sessions (user_id)
      `);

      initialized = true;
    })();

    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  }

  function isSecureRequest(req) {
    return Boolean(req.socket && req.socket.encrypted);
  }

  function parseDataUrlImage(dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string") {
      return null;
    }
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return null;
    }
    const mimeType = match[1].toLowerCase();
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, "base64");
    if (!buffer.length || buffer.length > MAX_ICON_BYTES) {
      return null;
    }
    const extMap = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
    };
    const ext = extMap[mimeType];
    if (!ext) {
      return null;
    }
    return { buffer, ext };
  }

  function saveUserIcon({ sub, iconDataUrl }) {
    if (!iconDataUrl) {
      return null;
    }
    const parsed = parseDataUrlImage(iconDataUrl);
    if (!parsed) {
      throw new Error("invalid_icon_image");
    }
    fs.mkdirSync(USER_ICON_DIR, { recursive: true });
    const filename = `${sub}-${Date.now()}.${parsed.ext}`;
    const absPath = path.join(USER_ICON_DIR, filename);
    fs.writeFileSync(absPath, parsed.buffer);
    return `/uploads/user_icons/${filename}`;
  }

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

  async function findGoogleUserBySub(sub) {
    if (!pool) {
      return memoryStore.usersBySub.get(sub) || null;
    }
    await ensureSchema();
    const [rows] = await pool.query(
      `SELECT u.user_id, u.username, u.icon_url, u.email_verified, p.email
       FROM login.user_auth_providers p
       JOIN login.users u ON u.user_id = p.user_id
       WHERE p.provider = 'google' AND p.provider_user_id = ?
       LIMIT 1`,
      [sub]
    );
    return rows[0] || null;
  }

  async function createGoogleUser({ payload, username, iconUrl }) {
    const sub = payload.sub;
    const email = payload.email || null;
    const name = payload.name || null;
    const finalUsername = username || name || null;
    const finalIconUrl = iconUrl || payload.picture || null;
    const emailVerified = Boolean(payload.email_verified);

    if (!pool) {
      const existing = memoryStore.usersBySub.get(sub);
      if (existing) {
        return existing;
      }
      const user = {
        user_id: memoryStore.nextUserId++,
        username: finalUsername,
        icon_url: finalIconUrl,
        email,
        email_verified: emailVerified,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_login_at: new Date().toISOString(),
      };
      memoryStore.usersBySub.set(sub, user);
      return user;
    }

    await ensureSchema();
    const [createdRows] = await pool.query(
      `WITH new_user AS (
         INSERT INTO login.users (
           username, icon_url, email_verified, created_at, updated_at, last_login_at
         )
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING user_id, username, icon_url, email_verified
       ),
       new_provider AS (
         INSERT INTO login.user_auth_providers (
           user_id, provider, provider_user_id, email, password_hash, created_at
         )
         SELECT user_id, 'google', ?, ?, NULL, CURRENT_TIMESTAMP
         FROM new_user
         RETURNING user_id, email
       )
       SELECT n.user_id, n.username, n.icon_url, n.email_verified, p.email
       FROM new_user n
       JOIN new_provider p ON p.user_id = n.user_id`,
      [finalUsername, finalIconUrl, emailVerified, sub, email]
    );

    return createdRows[0];
  }

  async function updateLoginMeta({ userId, payload }) {
    const emailVerified = Boolean(payload.email_verified);
    const name = payload.name || null;
    const picture = payload.picture || null;

    if (!pool) {
      for (const user of memoryStore.usersBySub.values()) {
        if (user.user_id === userId) {
          user.last_login_at = new Date().toISOString();
          user.updated_at = new Date().toISOString();
          user.email_verified = user.email_verified || emailVerified;
          if (!user.username && name) {
            user.username = name;
          }
          if (!user.icon_url && picture) {
            user.icon_url = picture;
          }
          break;
        }
      }
      return;
    }

    await ensureSchema();
    await pool.query(
      `UPDATE login.users
       SET last_login_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP,
           email_verified = (email_verified OR ?),
           username = COALESCE(username, ?),
           icon_url = COALESCE(icon_url, ?)
       WHERE user_id = ?`,
      [emailVerified, name, picture, userId]
    );
  }

  async function updateSignupProfile({ userId, username, iconUrl, payload }) {
    const emailVerified = Boolean(payload.email_verified);

    if (!pool) {
      for (const user of memoryStore.usersBySub.values()) {
        if (user.user_id === userId) {
          user.username = username;
          user.icon_url = iconUrl;
          user.last_login_at = new Date().toISOString();
          user.updated_at = new Date().toISOString();
          user.email_verified = user.email_verified || emailVerified;
          break;
        }
      }
      return;
    }

    await ensureSchema();
    await pool.query(
      `UPDATE login.users
       SET username = ?,
           icon_url = ?,
           updated_at = CURRENT_TIMESTAMP,
           last_login_at = CURRENT_TIMESTAMP,
           email_verified = (email_verified OR ?)
       WHERE user_id = ?`,
      [username, iconUrl, emailVerified, userId]
    );
  }

  async function createSession(userId) {
    const sessionId = crypto.randomBytes(32).toString("hex");

    if (!pool) {
      const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
      memoryStore.sessions.set(sessionId, { userId, expiresAt });
      return sessionId;
    }

    await ensureSchema();
    await pool.query(
      `INSERT INTO login.user_sessions (session_id, user_id, expires_at)
       VALUES (?, ?, CURRENT_TIMESTAMP + INTERVAL '7 days')`,
      [sessionId, userId]
    );
    return sessionId;
  }

  async function findSession(sessionId) {
    if (!sessionId) {
      return null;
    }

    if (!pool) {
      const session = memoryStore.sessions.get(sessionId);
      if (!session || session.expiresAt <= Date.now()) {
        memoryStore.sessions.delete(sessionId);
        return null;
      }
      for (const user of memoryStore.usersBySub.values()) {
        if (user.user_id === session.userId) {
          return {
            user_id: user.user_id,
            username: user.username,
            icon_url: user.icon_url,
            email: user.email || null,
          };
        }
      }
      return null;
    }

    await ensureSchema();
    const [rows] = await pool.query(
      `SELECT s.user_id, u.username, u.icon_url, p.email
       FROM login.user_sessions s
       JOIN login.users u ON u.user_id = s.user_id
       LEFT JOIN login.user_auth_providers p
         ON p.user_id = s.user_id AND p.provider = 'google'
       WHERE s.session_id = ?
         AND s.expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
      [sessionId]
    );
    return rows[0] || null;
  }

  async function verifyGoogleToken(idToken) {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) {
      throw new Error("invalid_token_payload");
    }
    return payload;
  }

  async function handleGoogleLogin(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!GOOGLE_CLIENT_ID || !client) {
      sendJson(res, 500, { error: "google_client_id_not_configured" });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }

    const idToken = body.id_token;
    if (!idToken || typeof idToken !== "string") {
      sendJson(res, 400, { error: "missing_id_token" });
      return;
    }

    try {
      const payload = await verifyGoogleToken(idToken);
      const user = await findGoogleUserBySub(payload.sub);
      if (!user) {
        sendJson(res, 404, { error: "account_not_found" });
        return;
      }
      await updateLoginMeta({ userId: user.user_id, payload });
      const sessionId = await createSession(user.user_id);

      res.setHeader(
        "Set-Cookie",
        createSessionCookie(sessionId, {
          secure: isSecureRequest(req),
          maxAge: SESSION_MAX_AGE_SECONDS,
        })
      );

      sendJson(res, 200, {
        ok: true,
        user: {
          userId: user.user_id,
          email: user.email || null,
          username: user.username || null,
          iconUrl: user.icon_url || null,
        },
      });
    } catch (err) {
      if (err.message === "invalid_icon_image") {
        sendJson(res, 400, { error: "invalid_icon_image" });
        return;
      }
      sendJson(res, 401, { error: "invalid_token", message: err.message });
    }
  }

  async function handleGoogleSignup(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!GOOGLE_CLIENT_ID || !client) {
      sendJson(res, 500, { error: "google_client_id_not_configured" });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }

    const idToken = body.id_token;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const iconDataUrl = typeof body.icon_data_url === "string" ? body.icon_data_url : "";

    if (!idToken || typeof idToken !== "string") {
      sendJson(res, 400, { error: "missing_id_token" });
      return;
    }
    if (!username) {
      sendJson(res, 400, { error: "missing_username" });
      return;
    }
    if (username.length > 50) {
      sendJson(res, 400, { error: "username_too_long" });
      return;
    }
    if (!iconDataUrl) {
      sendJson(res, 400, { error: "missing_icon_image" });
      return;
    }

    try {
      const payload = await verifyGoogleToken(idToken);
      const iconUrl = saveUserIcon({ sub: payload.sub, iconDataUrl });
      const existing = await findGoogleUserBySub(payload.sub);
      if (existing) {
        await updateSignupProfile({
          userId: existing.user_id,
          username,
          iconUrl,
          payload,
        });
        const sessionId = await createSession(existing.user_id);
        res.setHeader(
          "Set-Cookie",
          createSessionCookie(sessionId, {
            secure: isSecureRequest(req),
            maxAge: SESSION_MAX_AGE_SECONDS,
          })
        );
        sendJson(res, 200, {
          ok: true,
          updated: true,
          user: {
            userId: existing.user_id,
            email: existing.email || null,
            username,
            iconUrl,
          },
        });
        return;
      }

      const user = await createGoogleUser({
        payload,
        username,
        iconUrl,
      });
      const sessionId = await createSession(user.user_id);

      res.setHeader(
        "Set-Cookie",
        createSessionCookie(sessionId, {
          secure: isSecureRequest(req),
          maxAge: SESSION_MAX_AGE_SECONDS,
        })
      );

      sendJson(res, 200, {
        ok: true,
        user: {
          userId: user.user_id,
          email: user.email || null,
          username: user.username || null,
          iconUrl: user.icon_url || null,
        },
      });
    } catch (err) {
      if (err.message === "invalid_icon_image") {
        sendJson(res, 400, { error: "invalid_icon_image" });
        return;
      }
      sendJson(res, 401, { error: "invalid_token", message: err.message });
    }
  }

  async function handleMe(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    const cookies = parseCookies(req.headers.cookie || "");
    const sessionId = cookies[SESSION_COOKIE_NAME];
    const sessionUser = await findSession(sessionId);
    if (!sessionUser) {
      sendJson(res, 401, { authenticated: false });
      return;
    }
    sendJson(res, 200, {
      authenticated: true,
      user: {
        userId: sessionUser.user_id,
        email: sessionUser.email || null,
        username: sessionUser.username || null,
        iconUrl: sessionUser.icon_url || null,
      },
    });
  }

  return async function handleGoogleAuth(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/auth/google") {
      await handleGoogleLogin(req, res);
      return;
    }
    if (url.pathname === "/auth/google/signup") {
      await handleGoogleSignup(req, res);
      return;
    }
    if (url.pathname === "/auth/me") {
      await handleMe(req, res);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  };
}

module.exports = createGoogleAuthHandler;
