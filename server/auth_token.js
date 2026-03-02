const crypto = require("crypto");

const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "change-this-dev-access-token-secret";
const ACCESS_TOKEN_EXPIRES_IN_SECONDS = Number.parseInt(process.env.ACCESS_TOKEN_EXPIRES_IN_SECONDS, 10) || (60 * 60 * 24 * 7);

function base64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlDecode(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLength);
  return Buffer.from(padded, "base64").toString("utf8");
}

function signTokenSegment(segment) {
  return base64urlEncode(
    crypto.createHmac("sha256", ACCESS_TOKEN_SECRET).update(segment).digest()
  );
}

function createAccessToken(userId, options = {}) {
  const safeUserId = Number(userId);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) {
    throw new Error("invalid_user_id");
  }
  const now = Math.floor(Date.now() / 1000);
  const expIn = Number(options.expiresInSeconds) > 0
    ? Number(options.expiresInSeconds)
    : ACCESS_TOKEN_EXPIRES_IN_SECONDS;
  const payload = {
    sub: String(Math.trunc(safeUserId)),
    iat: now,
    exp: now + expIn,
  };
  const headerEncoded = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadEncoded = base64urlEncode(JSON.stringify(payload));
  const segment = `${headerEncoded}.${payloadEncoded}`;
  const signature = signTokenSegment(segment);
  return `${segment}.${signature}`;
}

function verifyAccessToken(token) {
  if (!token || typeof token !== "string") {
    throw new Error("missing_access_token");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("invalid_access_token_format");
  }
  const [headerEncoded, payloadEncoded, signature] = parts;
  const expectedSignature = signTokenSegment(`${headerEncoded}.${payloadEncoded}`);

  const expectedBuf = Buffer.from(expectedSignature);
  const actualBuf = Buffer.from(signature || "");
  if (
    expectedBuf.length !== actualBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, actualBuf)
  ) {
    throw new Error("invalid_access_token_signature");
  }

  let header;
  let payload;
  try {
    header = JSON.parse(base64urlDecode(headerEncoded));
    payload = JSON.parse(base64urlDecode(payloadEncoded));
  } catch {
    throw new Error("invalid_access_token_payload");
  }

  if (!header || header.alg !== "HS256") {
    throw new Error("invalid_access_token_alg");
  }

  const exp = Number(payload && payload.exp);
  const sub = Number(payload && payload.sub);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(exp) || exp <= now) {
    throw new Error("access_token_expired");
  }
  if (!Number.isFinite(sub) || sub <= 0) {
    throw new Error("invalid_access_token_sub");
  }

  return {
    userId: Math.trunc(sub),
    exp,
    iat: Number(payload.iat) || null,
  };
}

function extractBearerToken(req) {
  const raw = req && req.headers ? req.headers.authorization : "";
  if (!raw || typeof raw !== "string") {
    return "";
  }
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function getAccessTokenExpiresInSeconds() {
  return ACCESS_TOKEN_EXPIRES_IN_SECONDS;
}

module.exports = {
  createAccessToken,
  verifyAccessToken,
  extractBearerToken,
  getAccessTokenExpiresInSeconds,
};

