const crypto = require("crypto");

const COOKIE_NAME = "stepby_dev_admin_session";
const SESSION_TTL_MS = 30 * 60 * 1000;
const attempts = new Map();

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((item) => {
    const index = item.indexOf("=");
    return index < 0 ? ["", ""] : [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function createAdminSession({ sendJson }) {
  function verify(req) {
    const secret = String(process.env.DEV_ADMIN_KEY || "");
    const token = parseCookies(req)[COOKIE_NAME] || "";
    const split = token.lastIndexOf(".");
    if (!secret || split < 1) return false;
    const payload = token.slice(0, split);
    if (!safeEqual(token.slice(split + 1), sign(payload, secret))) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return data.scope === "dev-admin" && Number.isFinite(data.exp) && data.exp > Date.now();
    } catch { return false; }
  }

  function handle(req, res) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
    const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
    const now = Date.now();
    const recent = (attempts.get(ip) || []).filter((time) => now - time < 10 * 60 * 1000);
    recent.push(now); attempts.set(ip, recent);
    if (recent.length > 10) return sendJson(res, 429, { error: "rate_limited" });
    const secret = String(process.env.DEV_ADMIN_KEY || "");
    if (!secret || !safeEqual(req.headers["x-stepby-admin-key"], secret)) return sendJson(res, 403, { error: "admin_required" });
    const payload = Buffer.from(JSON.stringify({ scope: "dev-admin", exp: now + SESSION_TTL_MS, nonce: crypto.randomBytes(16).toString("base64url") })).toString("base64url");
    const token = `${payload}.${sign(payload, secret)}`;
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/dev-api; Max-Age=1800; HttpOnly; Secure; SameSite=Strict`);
    return sendJson(res, 200, { ok: true, expiresInSeconds: 1800 });
  }

  return { handle, verify };
}

module.exports = { createAdminSession };
