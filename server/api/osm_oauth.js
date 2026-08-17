const crypto = require("crypto");
const { createDbPool } = require("../db");
const { extractBearerToken, verifyAccessToken } = require("../auth_token");
const { serviceAccountConfig } = require("../osm/service_account_client");

const DEFAULT_AUTHORIZE_URL = "https://www.openstreetmap.org/oauth2/authorize";
const DEFAULT_TOKEN_URL = "https://www.openstreetmap.org/oauth2/token";
const DEFAULT_USER_DETAILS_URL = "https://api.openstreetmap.org/api/0.6/user/details.json";
const REQUIRED_SCOPE = "openid read_prefs write_api";

function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function safeReturnUrl(candidate, configuredReturnUrl) {
  const fallback = String(configuredReturnUrl || "").trim();
  if (!fallback) return "";
  try {
    const allowed = new URL(fallback);
    const requested = new URL(String(candidate || fallback));
    if (requested.origin !== allowed.origin || !requested.pathname.startsWith("/StepBy/UI10/")) {
      return fallback;
    }
    return requested.toString();
  } catch {
    return fallback;
  }
}

function createOsmOAuthHandler({ sendJson, fetchImpl = global.fetch }) {
  const { pool } = createDbPool();
  const clientId = String(process.env.OSM_OAUTH_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.OSM_OAUTH_CLIENT_SECRET || "").trim();
  const redirectUri = String(process.env.OSM_OAUTH_REDIRECT_URI || "").trim();
  const frontendReturnUrl = String(process.env.OSM_OAUTH_FRONTEND_RETURN_URL || "").trim();
  const encryptionSecret = String(process.env.OSM_TOKEN_ENCRYPTION_KEY || "").trim();
  const authorizeUrl = String(process.env.OSM_OAUTH_AUTHORIZE_URL || DEFAULT_AUTHORIZE_URL);
  const tokenUrl = String(process.env.OSM_OAUTH_TOKEN_URL || DEFAULT_TOKEN_URL);
  const userDetailsUrl = String(process.env.OSM_USER_DETAILS_URL || DEFAULT_USER_DETAILS_URL);
  const encryptionKey = encryptionSecret ? sha256(encryptionSecret) : null;
  const configured = Boolean(pool && clientId && redirectUri && frontendReturnUrl && encryptionKey && fetchImpl);
  let initialized = false;
  let initPromise = null;

  function encrypt(value) {
    if (!encryptionKey) throw new Error("osm_encryption_not_configured");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    return `${base64Url(iv)}.${base64Url(cipher.getAuthTag())}.${base64Url(ciphertext)}`;
  }

  function decrypt(value) {
    if (!encryptionKey) throw new Error("osm_encryption_not_configured");
    const [ivPart, tagPart, dataPart] = String(value || "").split(".");
    if (!ivPart || !tagPart || !dataPart) throw new Error("invalid_encrypted_value");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }

  async function ensureSchema() {
    if (!pool) throw new Error("database_unavailable");
    if (initialized) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await pool.query("CREATE SCHEMA IF NOT EXISTS login");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS login.osm_connections (
          user_id BIGINT PRIMARY KEY REFERENCES login.users(user_id) ON DELETE RESTRICT,
          osm_user_id BIGINT NOT NULL UNIQUE,
          osm_display_name TEXT NOT NULL,
          access_token_encrypted TEXT NOT NULL,
          granted_scope TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','revoked','invalid')),
          connected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_verified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          revoked_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS login.osm_oauth_states (
          state_hash TEXT PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES login.users(user_id) ON DELETE CASCADE,
          code_verifier_encrypted TEXT NOT NULL,
          return_url TEXT NOT NULL,
          flow_mode TEXT NOT NULL DEFAULT 'redirect' CHECK (flow_mode IN ('redirect','popup')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ
        )
      `);
      await pool.query("ALTER TABLE login.osm_oauth_states ADD COLUMN IF NOT EXISTS flow_mode TEXT NOT NULL DEFAULT 'redirect'");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS login.osm_connection_audit (
          audit_id BIGSERIAL PRIMARY KEY,
          user_id BIGINT REFERENCES login.users(user_id) ON DELETE RESTRICT,
          event_type TEXT NOT NULL,
          osm_user_id BIGINT,
          osm_display_name TEXT,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query(`
        CREATE OR REPLACE FUNCTION login.prevent_osm_audit_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'OSM connection audit is append-only';
        END $$
      `);
      await pool.query("DROP TRIGGER IF EXISTS osm_connection_audit_append_only ON login.osm_connection_audit");
      await pool.query(`
        CREATE TRIGGER osm_connection_audit_append_only
        BEFORE UPDATE OR DELETE ON login.osm_connection_audit
        FOR EACH ROW EXECUTE FUNCTION login.prevent_osm_audit_mutation()
      `);
      initialized = true;
    })();
    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  }

  async function appendAudit(userId, eventType, details = {}) {
    const osmUserId = details.osmUserId || null;
    const osmDisplayName = details.osmDisplayName || null;
    const safeDetails = { ...details };
    delete safeDetails.accessToken;
    delete safeDetails.code;
    delete safeDetails.codeVerifier;
    await pool.query(
      `INSERT INTO login.osm_connection_audit
       (user_id,event_type,osm_user_id,osm_display_name,details)
       VALUES (?,?,?,?,?::jsonb)
       RETURNING audit_id`,
      [userId || null, eventType, osmUserId, osmDisplayName, JSON.stringify(safeDetails)]
    );
  }

  async function authenticatedUserId(req) {
    const token = extractBearerToken(req);
    if (!token) return null;
    try {
      const verified = verifyAccessToken(token);
      return Number(verified.userId || verified.user_id || verified.sub || 0) || null;
    } catch {
      return null;
    }
  }

  function redirectWithResult(res, returnUrl, result, message) {
    const target = new URL(returnUrl || frontendReturnUrl);
    target.searchParams.set("osm", result);
    if (message) target.searchParams.set("osm_message", message);
    res.writeHead(302, { Location: target.toString(), "Cache-Control": "no-store" });
    res.end();
  }

  function finishAuthorization(res, pending, result, message) {
    if (!pending || pending.flow_mode !== "popup") {
      return redirectWithResult(res, pending && pending.return_url, result, message);
    }
    const returnTarget = new URL(pending.return_url || frontendReturnUrl);
    const targetOrigin = returnTarget.origin;
    const payload = JSON.stringify({ type: "stepby-osm-oauth-result", result, message: message || "" })
      .replace(/</g, "\\u003c");
    const fallbackUrl = new URL(pending.return_url || frontendReturnUrl);
    fallbackUrl.searchParams.set("osm", result);
    if (message) fallbackUrl.searchParams.set("osm_message", message);
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StepBy OSM連携</title></head><body><p>StepByへ戻ります。この画面は自動的に閉じます。</p><script>if(window.opener&&!window.opener.closed){window.opener.postMessage(${payload},${JSON.stringify(targetOrigin)});window.close();}setTimeout(function(){location.replace(${JSON.stringify(fallbackUrl.toString())});},800);<\/script></body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  }

  async function handleStatus(req, res) {
    const userId = await authenticatedUserId(req);
    if (!userId) return sendJson(res, 401, { error: "authentication_required" });
    const service = serviceAccountConfig();
    return sendJson(res, 200, {
      configured: service.configured,
      connected: service.configured,
      editorMode: "stepby_service_account",
      connection: service.configured ? { displayName: service.displayName, managedByStepBy: true } : null,
      osmWritesEnabled: process.env.OSM_WRITES_ENABLED === "true" && process.env.OSM_COMMUNITY_APPROVED === "true",
    });
    /* Legacy per-user OAuth data is retained read-only for audit/migration.
    if (pool && encryptionKey) await ensureSchema();
    if (!configured) {
      return sendJson(res, 200, { configured: false, connected: false, reason: "osm_oauth_app_not_configured" });
    }
    const [rows] = await pool.query(
      `SELECT osm_user_id,osm_display_name,granted_scope,status,connected_at,last_verified_at,revoked_at
       FROM login.osm_connections WHERE user_id=? LIMIT 1`,
      [userId]
    );
    const row = rows[0] || null;
    sendJson(res, 200, {
      configured: true,
      connected: Boolean(row && row.status === "connected"),
      connection: row ? {
        osmUserId: row.osm_user_id,
        displayName: row.osm_display_name,
        scope: row.granted_scope,
        status: row.status,
        connectedAt: row.connected_at,
        lastVerifiedAt: row.last_verified_at,
        revokedAt: row.revoked_at,
      } : null,
      osmWritesEnabled: process.env.OSM_WRITES_ENABLED === "true",
    });
    */
  }

  async function handleStart(req, res, requestUrl) {
    const userId = await authenticatedUserId(req);
    if (!userId) return sendJson(res, 401, { error: "authentication_required" });
    return sendJson(res, 410, { error: "individual_osm_oauth_retired", editorMode: "stepby_service_account" });
    /* Legacy individual OAuth flow retained temporarily for audit reference.
    if (!configured) return sendJson(res, 503, { error: "osm_oauth_app_not_configured" });
    await ensureSchema();
    const returnUrl = safeReturnUrl(requestUrl.searchParams.get("return_url"), frontendReturnUrl);
    const flowMode = requestUrl.searchParams.get("mode") === "popup" ? "popup" : "redirect";
    const state = base64Url(crypto.randomBytes(32));
    const verifier = base64Url(crypto.randomBytes(48));
    const challenge = base64Url(sha256(verifier));
    await pool.query(
      `INSERT INTO login.osm_oauth_states
       (state_hash,user_id,code_verifier_encrypted,return_url,flow_mode,expires_at)
       VALUES (?,?,?,?,?,CURRENT_TIMESTAMP + INTERVAL '10 minutes')
       RETURNING state_hash`,
      [base64Url(sha256(state)), userId, encrypt(verifier), returnUrl, flowMode]
    );
    await appendAudit(userId, "authorization_started", { scope: REQUIRED_SCOPE });
    const target = new URL(authorizeUrl);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("client_id", clientId);
    target.searchParams.set("redirect_uri", redirectUri);
    target.searchParams.set("scope", REQUIRED_SCOPE);
    target.searchParams.set("state", state);
    target.searchParams.set("code_challenge", challenge);
    target.searchParams.set("code_challenge_method", "S256");
    sendJson(res, 200, { authorizationUrl: target.toString() });
    */
  }

  async function handleCallback(req, res, requestUrl) {
    if (!configured) return sendJson(res, 503, { error: "osm_oauth_app_not_configured" });
    await ensureSchema();
    const state = requestUrl.searchParams.get("state") || "";
    const code = requestUrl.searchParams.get("code") || "";
    const stateHash = base64Url(sha256(state));
    const [rows] = await pool.query(
      `SELECT state_hash,user_id,code_verifier_encrypted,return_url,flow_mode,expires_at,used_at
       FROM login.osm_oauth_states WHERE state_hash=? LIMIT 1`,
      [stateHash]
    );
    const pending = rows[0] || null;
    if (!pending || pending.used_at || new Date(pending.expires_at).getTime() <= Date.now()) {
      return redirectWithResult(res, frontendReturnUrl, "error", "認証の有効期限が切れました。もう一度お試しください。");
    }
    await pool.query("UPDATE login.osm_oauth_states SET used_at=CURRENT_TIMESTAMP WHERE state_hash=? AND used_at IS NULL", [stateHash]);
    if (requestUrl.searchParams.get("error") || !code) {
      await appendAudit(pending.user_id, "authorization_denied", { reason: requestUrl.searchParams.get("error") || "missing_code" });
      return finishAuthorization(res, pending, "cancelled", "OSM連携はキャンセルされました。");
    }
    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: decrypt(pending.code_verifier_encrypted),
      });
      if (clientSecret) body.set("client_secret", clientSecret);
      const tokenResponse = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "StepBy-development" },
        body,
      });
      const tokenPayload = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokenPayload.access_token) throw new Error("token_exchange_failed");
      const detailsResponse = await fetchImpl(userDetailsUrl, {
        headers: { Authorization: `Bearer ${tokenPayload.access_token}`, "User-Agent": "StepBy-development" },
      });
      const detailsPayload = await detailsResponse.json().catch(() => ({}));
      const osmUser = detailsPayload.user || null;
      if (!detailsResponse.ok || !osmUser || !osmUser.id || !osmUser.display_name) throw new Error("user_details_failed");
      await pool.query(
        `INSERT INTO login.osm_connections
         (user_id,osm_user_id,osm_display_name,access_token_encrypted,granted_scope,status,connected_at,last_verified_at,revoked_at,updated_at)
         VALUES (?,?,?,?,?,'connected',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL,CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE SET
           osm_user_id=EXCLUDED.osm_user_id,
           osm_display_name=EXCLUDED.osm_display_name,
           access_token_encrypted=EXCLUDED.access_token_encrypted,
           granted_scope=EXCLUDED.granted_scope,
           status='connected',
           connected_at=CURRENT_TIMESTAMP,
           last_verified_at=CURRENT_TIMESTAMP,
           revoked_at=NULL,
           updated_at=CURRENT_TIMESTAMP
         RETURNING user_id`,
        [pending.user_id, osmUser.id, osmUser.display_name, encrypt(tokenPayload.access_token), tokenPayload.scope || REQUIRED_SCOPE]
      );
      await appendAudit(pending.user_id, "connected", { osmUserId: osmUser.id, osmDisplayName: osmUser.display_name, scope: tokenPayload.scope || REQUIRED_SCOPE });
      finishAuthorization(res, pending, "connected", "OSMアカウントを連携しました。");
    } catch (error) {
      await appendAudit(pending.user_id, "authorization_failed", { reason: error.message || "unknown" });
      finishAuthorization(res, pending, "error", "OSM連携を完了できませんでした。");
    }
  }

  async function handleDisconnect(req, res) {
    const userId = await authenticatedUserId(req);
    if (!userId) return sendJson(res, 401, { error: "authentication_required" });
    return sendJson(res, 410, { error: "service_account_managed_by_stepby" });
    /* Legacy individual disconnect is disabled in service-account mode.
    if (!configured) return sendJson(res, 503, { error: "osm_oauth_app_not_configured" });
    await ensureSchema();
    const [rows] = await pool.query("SELECT osm_user_id,osm_display_name,status FROM login.osm_connections WHERE user_id=? LIMIT 1", [userId]);
    const current = rows[0] || null;
    if (!current || current.status !== "connected") return sendJson(res, 200, { connected: false });
    await pool.query(
      `UPDATE login.osm_connections SET access_token_encrypted='',status='revoked',revoked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`,
      [userId]
    );
    await appendAudit(userId, "disconnected", { osmUserId: current.osm_user_id, osmDisplayName: current.osm_display_name, localOnly: true });
    sendJson(res, 200, { connected: false });
    */
  }

  return async function handleOsmOAuth(req, res) {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    try {
      if (req.method === "GET" && requestUrl.pathname === "/auth/osm/status") return await handleStatus(req, res);
      if (req.method === "POST" && requestUrl.pathname === "/auth/osm/start") return await handleStart(req, res, requestUrl);
      if (req.method === "GET" && requestUrl.pathname === "/auth/osm/callback") return await handleCallback(req, res, requestUrl);
      if (req.method === "POST" && requestUrl.pathname === "/auth/osm/disconnect") return await handleDisconnect(req, res);
      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      console.error("[osm-oauth] request_failed", error && error.message ? error.message : error);
      sendJson(res, 500, { error: "osm_oauth_failed" });
    }
  };
}

module.exports = createOsmOAuthHandler;
