const crypto = require("crypto");
const path = require("path");
const { extractBearerToken, verifyAccessToken } = require("../auth_token");
const { createLogger } = require("../logger");

const WINDOW_MS = 60 * 1000;
const counters = new Map();

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientAddress(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function consumeRateLimit(key, limit) {
  const now = Date.now();
  const current = counters.get(key);
  if (!current || now >= current.resetAt) {
    counters.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }
  current.count += 1;
  return {
    allowed: current.count <= limit,
    remaining: Math.max(0, limit - current.count),
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

function createDevApiGuard({ sendJson, logDir, allowedOrigins }) {
  const securityLogger = createLogger(path.join(logDir, "dev_api_security.csv"));
  const adminKey = process.env.DEV_ADMIN_KEY || "";
  const tokenSecretConfigured = String(process.env.ACCESS_TOKEN_SECRET || "").length >= 32;
  const allowedOriginSet = new Set(allowedOrigins || []);

  function log(label, req, details = {}) {
    securityLogger.appendLog(label, JSON.stringify({
      requestId: req.securityRequestId,
      method: req.method,
      path: req.url,
      ip: clientAddress(req),
      origin: req.headers.origin || "",
      userId: req.authUserId || null,
      ...details,
    }));
  }

  return function guardDevApi(req, res) {
    if (process.env.NODE_ENV !== "development") return true;
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const isApi = pathname.startsWith("/api/") || pathname.startsWith("/auth/");
    if (!isApi) return true;

    req.securityRequestId = crypto.randomUUID();
    res.setHeader("X-Request-Id", req.securityRequestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");

    const ip = clientAddress(req);
    const coarseRate = consumeRateLimit(`all:${ip}`, 300);
    if (!coarseRate.allowed) {
      res.setHeader("Retry-After", String(coarseRate.retryAfterSeconds));
      sendJson(res, 429, { error: "rate_limited", retryAfterSeconds: coarseRate.retryAfterSeconds, requestId: req.securityRequestId });
      return false;
    }

    const origin = String(req.headers.origin || "");
    if (origin && !allowedOriginSet.has(origin)) {
      log("ORIGIN_REJECTED", req);
      sendJson(res, 403, { error: "origin_not_allowed", requestId: req.securityRequestId });
      return false;
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    const maxBodyBytes = pathname.startsWith("/auth/profile")
      ? 6 * 1024 * 1024
      : pathname === "/api/osm/split-plan" ? 1024 * 1024 : 128 * 1024;
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      log("BODY_REJECTED", req, { contentLength, maxBodyBytes });
      sendJson(res, 413, { error: "payload_too_large", requestId: req.securityRequestId });
      return false;
    }
    let streamedBytes = 0;
    req.on("data", (chunk) => {
      streamedBytes += chunk.length;
      if (streamedBytes > maxBodyBytes && !res.headersSent) {
        log("STREAM_BODY_REJECTED", req, { streamedBytes, maxBodyBytes });
        sendJson(res, 413, { error: "payload_too_large", requestId: req.securityRequestId });
        req.destroy();
      }
    });

    const publicRoute = pathname === "/api/config" || pathname === "/auth/guest" || pathname === "/auth/google" || pathname === "/auth/google/signup";
    if (publicRoute) {
      const rate = consumeRateLimit(`public:${ip}:${pathname}`, pathname === "/api/config" ? 60 : 10);
      if (!rate.allowed) {
        res.setHeader("Retry-After", String(rate.retryAfterSeconds));
        log("RATE_LIMITED_PUBLIC", req);
        sendJson(res, 429, { error: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds, requestId: req.securityRequestId });
        return false;
      }
      if (pathname !== "/api/config" && (!tokenSecretConfigured || !adminKey)) {
        log("SECURITY_CONFIG_MISSING", req);
        sendJson(res, 503, { error: "security_not_configured", requestId: req.securityRequestId });
        return false;
      }
      return true;
    }

    if (!tokenSecretConfigured || !adminKey) {
      log("SECURITY_CONFIG_MISSING", req);
      sendJson(res, 503, { error: "security_not_configured", requestId: req.securityRequestId });
      return false;
    }

    if (pathname === "/api/fitting-comparisons" && req.method === "GET") {
      const attemptRate = consumeRateLimit(`admin-attempt:${ip}`, 20);
      if (!attemptRate.allowed) {
        res.setHeader("Retry-After", String(attemptRate.retryAfterSeconds));
        sendJson(res, 429, { error: "rate_limited", retryAfterSeconds: attemptRate.retryAfterSeconds, requestId: req.securityRequestId });
        return false;
      }
      if (!adminKey || !safeEqual(req.headers["x-stepby-admin-key"], adminKey)) {
        log("ADMIN_REJECTED", req);
        sendJson(res, 403, { error: "admin_required", requestId: req.securityRequestId });
        return false;
      }
      const rate = consumeRateLimit(`admin:${ip}`, 30);
      if (!rate.allowed) {
        res.setHeader("Retry-After", String(rate.retryAfterSeconds));
        log("RATE_LIMITED_ADMIN", req);
        sendJson(res, 429, { error: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds, requestId: req.securityRequestId });
        return false;
      }
      log("ADMIN_ALLOWED", req);
      return true;
    }

    const anonymousApiRate = consumeRateLimit(`protected-attempt:${ip}`, 180);
    if (!anonymousApiRate.allowed) {
      res.setHeader("Retry-After", String(anonymousApiRate.retryAfterSeconds));
      sendJson(res, 429, { error: "rate_limited", retryAfterSeconds: anonymousApiRate.retryAfterSeconds, requestId: req.securityRequestId });
      return false;
    }

    try {
      const verified = verifyAccessToken(extractBearerToken(req));
      req.authUserId = verified.userId;
    } catch (error) {
      log("AUTH_REJECTED", req, { reason: error.message });
      sendJson(res, 401, { error: "unauthorized", requestId: req.securityRequestId });
      return false;
    }

    const heavyRoute = pathname === "/api/osm-walkable-network" || pathname === "/api/osm-tactile-ways" || pathname === "/api/trace";
    const ipLimit = consumeRateLimit(`protected-ip:${ip}`, heavyRoute ? 30 : 180);
    if (!ipLimit.allowed) {
      res.setHeader("Retry-After", String(ipLimit.retryAfterSeconds));
      log("RATE_LIMITED_IP", req, { heavyRoute });
      sendJson(res, 429, { error: "rate_limited", retryAfterSeconds: ipLimit.retryAfterSeconds, requestId: req.securityRequestId });
      return false;
    }
    const limit = heavyRoute ? 15 : pathname === "/api/match" ? 60 : 120;
    const rate = consumeRateLimit(`user:${req.authUserId}:${pathname}`, limit);
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSeconds));
      log("RATE_LIMITED_USER", req, { limit });
      sendJson(res, 429, { error: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds, requestId: req.securityRequestId });
      return false;
    }
    res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
    return true;
  };
}

module.exports = createDevApiGuard;
