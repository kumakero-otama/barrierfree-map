const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { OAuth2Client } = require("google-auth-library");
const { createDbPool } = require("../db");
const {
  createAccessToken,
  verifyAccessToken,
  extractBearerToken,
  getAccessTokenExpiresInSeconds,
} = require("../auth_token");

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

function clearSessionCookie({ secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
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
        ADD COLUMN IF NOT EXISTS is_pro BOOLEAN DEFAULT FALSE
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS login.user_auth_providers (
          auth_id SERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES login.users(user_id) ON DELETE CASCADE,
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
          user_id BIGINT NOT NULL REFERENCES login.users(user_id) ON DELETE CASCADE,
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

  async function findUserById(userId) {
    const safeUserId = Number(userId);
    if (!Number.isFinite(safeUserId) || safeUserId <= 0) {
      return null;
    }
    if (!pool) {
      for (const user of memoryStore.usersBySub.values()) {
        if (Number(user.user_id) === safeUserId) {
          return user;
        }
      }
      return null;
    }
    await ensureSchema();
    const [rows] = await pool.query(
      `SELECT u.user_id, u.username, u.icon_url, u.email_verified, p.email,
              u.total_tactile_length, u.total_road_posts, u.total_hearts
       FROM login.users u
       LEFT JOIN login.user_auth_providers p
         ON p.user_id = u.user_id AND p.provider = 'google'
       WHERE u.user_id = ?
       LIMIT 1`,
      [safeUserId]
    );
    return rows[0] || null;
  }

  function toAuthUserPayload(user) {
    return {
      userId: user.user_id,
      email: user.email || null,
      username: user.username || null,
      iconUrl: user.icon_url || null,
      totalTactileLength: Number(user.total_tactile_length || 0),
      totalRoadPosts: Number(user.total_road_posts || 0),
      totalHearts: Number(user.total_hearts || 0),
    };
  }

  async function resolveUserFromAccessToken(req) {
    const bearerToken = extractBearerToken(req);
    if (!bearerToken) {
      return { user: null, authError: null };
    }
    try {
      const verified = verifyAccessToken(bearerToken);
      const user = await findUserById(verified.userId);
      if (!user) {
        return { user: null, authError: "user_not_found" };
      }
      return { user, authError: null };
    } catch (err) {
      return { user: null, authError: err.message || "invalid_access_token" };
    }
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
        is_pro: false,
        email,
        email_verified: emailVerified,
        total_tactile_length: 0,
        total_road_posts: 0,
        total_hearts: 0,
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
       VALUES (?, ?, CURRENT_TIMESTAMP + INTERVAL '7 days')
       RETURNING session_id`,
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
            is_pro: Boolean(user.is_pro),
            email: user.email || null,
            total_tactile_length: user.total_tactile_length || 0,
            total_road_posts: user.total_road_posts || 0,
            total_hearts: user.total_hearts || 0,
          };
        }
      }
      return null;
    }

    await ensureSchema();
    const [rows] = await pool.query(
      `SELECT s.user_id,
              u.username,
              u.icon_url,
              u.is_pro,
              p.email,
              u.total_tactile_length,
              u.total_road_posts,
              u.total_hearts
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

  async function deleteSession(sessionId) {
    if (!sessionId) {
      return;
    }
    if (!pool) {
      memoryStore.sessions.delete(sessionId);
      return;
    }
    await ensureSchema();
    await pool.query("DELETE FROM login.user_sessions WHERE session_id = ?", [sessionId]);
  }

  async function getGoogleSubByUserId(userId) {
    if (!pool) {
      for (const [sub, user] of memoryStore.usersBySub.entries()) {
        if (user.user_id === userId) {
          return sub;
        }
      }
      return `user-${userId}`;
    }
    await ensureSchema();
    const [rows] = await pool.query(
      `SELECT provider_user_id
       FROM login.user_auth_providers
       WHERE user_id = ? AND provider = 'google'
       LIMIT 1`,
      [userId]
    );
    return (rows[0] && rows[0].provider_user_id) || `user-${userId}`;
  }

  async function updateProfile({ userId, username, iconUrl }) {
    if (!pool) {
      for (const user of memoryStore.usersBySub.values()) {
        if (user.user_id === userId) {
          user.username = username;
          if (iconUrl) {
            user.icon_url = iconUrl;
          }
          user.updated_at = new Date().toISOString();
          return user;
        }
      }
      return null;
    }

    await ensureSchema();
    let result;
    if (iconUrl) {
      [result] = await pool.query(
        `UPDATE login.users
         SET username = ?,
             icon_url = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [username, iconUrl, userId]
      );
    } else {
      [result] = await pool.query(
        `UPDATE login.users
         SET username = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`,
        [username, userId]
      );
    }
    if (!result || Number(result.affectedRows || 0) < 1) {
      return null;
    }
    const [rows] = await pool.query(
      `SELECT user_id, username, icon_url
       FROM login.users
       WHERE user_id = ?
       LIMIT 1`,
      [userId]
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

  function isTokenError(err) {
    const msg = err && err.message ? String(err.message) : "";
    return (
      msg.includes("Token used too late") ||
      msg.includes("Wrong number of segments") ||
      msg.includes("No pem found for envelope") ||
      msg.includes("audience") ||
      msg.includes("issuer") ||
      msg.includes("invalid_token_payload")
    );
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

    let payload;
    try {
      payload = await verifyGoogleToken(idToken);
    } catch (err) {
      sendJson(res, 401, { error: "invalid_token", message: err.message });
      return;
    }

    try {
      const user = await findGoogleUserBySub(payload.sub);
      if (!user) {
        sendJson(res, 404, { error: "account_not_found" });
        return;
      }
      await updateLoginMeta({ userId: user.user_id, payload });
      const accessToken = createAccessToken(user.user_id);
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
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: getAccessTokenExpiresInSeconds(),
        user: toAuthUserPayload(user),
      });
    } catch (err) {
      sendJson(res, 500, { error: "login_failed", message: err.message });
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
    if (username && username.length > 50) {
      sendJson(res, 400, { error: "username_too_long" });
      return;
    }
    if (!iconDataUrl) {
      sendJson(res, 400, { error: "missing_icon_image" });
      return;
    }

    let payload;
    try {
      payload = await verifyGoogleToken(idToken);
    } catch (err) {
      sendJson(res, 401, { error: "invalid_token", message: err.message });
      return;
    }

    try {
      const existing = await findGoogleUserBySub(payload.sub);
      let iconUrl = saveUserIcon({ sub: payload.sub, iconDataUrl });
      if (existing) {
        const finalUsername = username;
        await updateSignupProfile({
          userId: existing.user_id,
          username: finalUsername,
          iconUrl,
          payload,
        });
        const accessToken = createAccessToken(existing.user_id);
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
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: getAccessTokenExpiresInSeconds(),
          user: {
            userId: existing.user_id,
            email: existing.email || null,
            username: finalUsername,
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
      const accessToken = createAccessToken(user.user_id);
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
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: getAccessTokenExpiresInSeconds(),
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
      if (isTokenError(err)) {
        sendJson(res, 401, { error: "invalid_token", message: err.message });
        return;
      }
      sendJson(res, 500, { error: "signup_failed", message: err.message });
    }
  }

  async function handleMe(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    const bearerResolved = await resolveUserFromAccessToken(req);
    if (bearerResolved.authError) {
      sendJson(res, 401, { authenticated: false, error: "invalid_access_token" });
      return;
    }
    let sessionUser = bearerResolved.user;
    if (!sessionUser) {
      const cookies = parseCookies(req.headers.cookie || "");
      const sessionId = cookies[SESSION_COOKIE_NAME];
      sessionUser = await findSession(sessionId);
    }
    if (!sessionUser) {
      sendJson(res, 401, { authenticated: false });
      return;
    }
    sendJson(res, 200, {
      authenticated: true,
      user: toAuthUserPayload(sessionUser),
    });
  }

  async function handleLogout(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    const bearerToken = extractBearerToken(req);
    if (bearerToken) {
      try {
        verifyAccessToken(bearerToken);
      } catch {
        sendJson(res, 401, { error: "invalid_access_token" });
        return;
      }
    }
    const cookies = parseCookies(req.headers.cookie || "");
    const sessionId = cookies[SESSION_COOKIE_NAME];
    try {
      await deleteSession(sessionId);
    } catch {
      // Continue and clear cookie even if DB delete fails.
    }
    res.setHeader(
      "Set-Cookie",
      clearSessionCookie({
        secure: isSecureRequest(req),
      })
    );
    sendJson(res, 200, { ok: true });
  }

  async function handleProfileUpdate(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    const bearerResolved = await resolveUserFromAccessToken(req);
    if (bearerResolved.authError) {
      sendJson(res, 401, { error: "invalid_access_token" });
      return;
    }
    let sessionUser = bearerResolved.user;
    if (!sessionUser) {
      const cookies = parseCookies(req.headers.cookie || "");
      const sessionId = cookies[SESSION_COOKIE_NAME];
      sessionUser = await findSession(sessionId);
    }
    if (!sessionUser) {
      sendJson(res, 401, { authenticated: false });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
      return;
    }

    const username = typeof body.username === "string" ? body.username.trim() : "";
    const iconDataUrl = typeof body.icon_data_url === "string" ? body.icon_data_url : "";

    if (!username) {
      sendJson(res, 400, { error: "missing_username" });
      return;
    }
    if (username.length > 50) {
      sendJson(res, 400, { error: "username_too_long" });
      return;
    }

    try {
      let iconUrl = null;
      if (iconDataUrl) {
        const sub = await getGoogleSubByUserId(sessionUser.user_id);
        iconUrl = saveUserIcon({ sub, iconDataUrl });
      }
      const updatedUser = await updateProfile({
        userId: sessionUser.user_id,
        username,
        iconUrl,
      });
      if (!updatedUser) {
        sendJson(res, 404, { error: "user_not_found" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        user: {
          userId: updatedUser.user_id,
          username: updatedUser.username || null,
          iconUrl: updatedUser.icon_url || null,
        },
      });
    } catch (err) {
      if (err.message === "invalid_icon_image") {
        sendJson(res, 400, { error: "invalid_icon_image" });
        return;
      }
      console.error(`[auth/profile] profile_update_failed: ${err.message}`);
      sendJson(res, 500, { error: "profile_update_failed", message: err.message });
    }
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
    if (url.pathname === "/auth/logout") {
      await handleLogout(req, res);
      return;
    }
    if (url.pathname === "/auth/profile") {
      await handleProfileUpdate(req, res);
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  };
}

module.exports = createGoogleAuthHandler;
