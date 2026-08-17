const crypto = require("crypto");
const { createDbPool } = require("../db");
let sharedPool;
let schemaReady = false;
let schemaPromise;

function getPool() {
  if (sharedPool === undefined) sharedPool = createDbPool().pool || null;
  return sharedPool;
}

function encryptionKey() {
  const secret = String(process.env.OSM_TOKEN_ENCRYPTION_KEY || "").trim();
  return secret ? crypto.createHash("sha256").update(secret).digest() : null;
}

function encrypt(value) {
  const key = encryptionKey();
  if (!key) throw new Error("osm_encryption_not_configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decrypt(value) {
  const key = encryptionKey();
  if (!key) throw new Error("osm_encryption_not_configured");
  const [iv, tag, encrypted] = String(value || "").split(".");
  if (!iv || !tag || !encrypted) throw new Error("invalid_encrypted_value");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

async function ensureServiceAccountSchema(pool) {
  if (schemaReady) return;
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
  await pool.query("CREATE SCHEMA IF NOT EXISTS login");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login.osm_service_account (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      osm_user_id BIGINT NOT NULL,
      osm_display_name TEXT NOT NULL,
      access_token_encrypted TEXT NOT NULL,
      granted_scope TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','invalid','revoked')),
      connected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_verified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login.osm_service_oauth_states (
      state_hash TEXT PRIMARY KEY,
      code_verifier_encrypted TEXT NOT NULL,
      expected_display_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login.osm_service_account_audit (
      audit_id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      osm_user_id BIGINT,
      osm_display_name TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`CREATE OR REPLACE FUNCTION login.prevent_osm_service_audit_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OSM service account audit is append-only'; END $$`);
  await pool.query("DROP TRIGGER IF EXISTS osm_service_account_audit_append_only ON login.osm_service_account_audit");
  await pool.query(`CREATE TRIGGER osm_service_account_audit_append_only BEFORE UPDATE OR DELETE ON login.osm_service_account_audit
    FOR EACH ROW EXECUTE FUNCTION login.prevent_osm_service_audit_mutation()`);
  schemaReady = true;
  })();
  try { await schemaPromise; } finally { schemaPromise = null; }
}

async function loadStoredServiceAccount() {
  const pool = getPool();
  if (!pool || !encryptionKey()) return null;
  await ensureServiceAccountSchema(pool);
  const [rows] = await pool.query(`SELECT osm_user_id,osm_display_name,access_token_encrypted,granted_scope,status,
    connected_at,last_verified_at FROM login.osm_service_account WHERE singleton=TRUE LIMIT 1`);
  const row = rows[0];
  if (!row || row.status !== "connected") return null;
  return {
    osmUserId: Number(row.osm_user_id), displayName: row.osm_display_name,
    accessToken: decrypt(row.access_token_encrypted), scope: row.granted_scope,
    connectedAt: row.connected_at, lastVerifiedAt: row.last_verified_at,
  };
}

module.exports = { encrypt, decrypt, ensureServiceAccountSchema, loadStoredServiceAccount };
