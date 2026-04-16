const crypto = require("crypto");

// アクセストークン署名に使う共有秘密鍵。未設定時は開発用の既定値を使う。
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || "change-this-dev-access-token-secret";
// アクセストークンの有効期限秒数。環境変数が不正な場合は 7 日を採用する。
const ACCESS_TOKEN_EXPIRES_IN_SECONDS = Number.parseInt(process.env.ACCESS_TOKEN_EXPIRES_IN_SECONDS, 10) || (60 * 60 * 24 * 7);

// Buffer または文字列を Base64URL 形式へ変換し、JWT の各セグメントに使える形へ整える。
function base64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// Base64URL 形式の文字列を通常の UTF-8 文字列へ戻す。
function base64urlDecode(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLength);
  return Buffer.from(padded, "base64").toString("utf8");
}

// 「header.payload」文字列へ HMAC-SHA256 署名を付与し、検証用シグネチャを作る。
function signTokenSegment(segment) {
  return base64urlEncode(
    crypto.createHmac("sha256", ACCESS_TOKEN_SECRET).update(segment).digest()
  );
}

// userId を subject にした簡易 JWT 風アクセストークンを生成する。
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

// 署名・有効期限・subject を検証し、認証済みユーザー情報として扱える最小情報を返す。
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

// Authorization ヘッダーから Bearer トークン本体だけを取り出す。
function extractBearerToken(req) {
  const raw = req && req.headers ? req.headers.authorization : "";
  if (!raw || typeof raw !== "string") {
    return "";
  }
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

// クライアントへトークン寿命を通知したい箇所向けに設定値を公開する。
function getAccessTokenExpiresInSeconds() {
  return ACCESS_TOKEN_EXPIRES_IN_SECONDS;
}

module.exports = {
  createAccessToken,
  verifyAccessToken,
  extractBearerToken,
  getAccessTokenExpiresInSeconds,
};
