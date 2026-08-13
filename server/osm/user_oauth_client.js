const crypto = require("crypto");
const { createOsmApiClient } = require("./osm_api_client");

function decryptAccessToken(encryptedValue) {
  const secret = String(process.env.OSM_TOKEN_ENCRYPTION_KEY || "").trim();
  if (!secret) throw new Error("osm_encryption_not_configured");
  const [ivPart, tagPart, dataPart] = String(encryptedValue || "").split(".");
  if (!ivPart || !tagPart || !dataPart) throw new Error("invalid_encrypted_value");
  const key = crypto.createHash("sha256").update(secret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function createUserOsmClient(pool, userId) {
  const [rows] = await pool.query(
    `SELECT access_token_encrypted,granted_scope,status
       FROM login.osm_connections WHERE user_id=? LIMIT 1`,
    [userId]
  );
  const connection = rows[0] || null;
  const scopes = new Set(String(connection && connection.granted_scope || "").split(/\s+/).filter(Boolean));
  if (!connection || connection.status !== "connected" || !connection.access_token_encrypted || !scopes.has("write_api")) {
    const error = new Error("osm_connection_required");
    error.status = 409;
    throw error;
  }
  return createOsmApiClient({
    baseUrl: process.env.OSM_API_BASE_URL,
    accessToken: decryptAccessToken(connection.access_token_encrypted),
  });
}

module.exports = { decryptAccessToken, createUserOsmClient };
