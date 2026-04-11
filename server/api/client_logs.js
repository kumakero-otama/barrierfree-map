const path = require("path");
const { randomUUID } = require("crypto");
const { createLogger } = require("../logger");

const MAX_BODY_BYTES = 256 * 1024;
const MAX_LOGS_PER_REQUEST = 200;
const MAX_STORED_LOG_IDS = 10000;
const CLIENT_LOG_MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_LEVELS = new Set(["debug", "info", "warn", "error"]);

function createServerRequestId() {
  const suffix = typeof randomUUID === "function"
    ? randomUUID().slice(0, 8)
    : Math.random().toString(16).slice(2, 10);
  return `srv_${Date.now()}_${suffix}`;
}

function pruneSeenLogIds(seenLogIds) {
  while (seenLogIds.size > MAX_STORED_LOG_IDS) {
    const oldestKey = seenLogIds.keys().next().value;
    if (!oldestKey) {
      break;
    }
    seenLogIds.delete(oldestKey);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let finished = false;

    const finish = (err, payload) => {
      if (finished) {
        return;
      }
      finished = true;
      if (err) {
        reject(err);
        return;
      }
      resolve(payload);
    };

    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        finish(new Error("payload_too_large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        finish(null, {});
        return;
      }
      try {
        finish(null, JSON.parse(body));
      } catch {
        finish(new Error("invalid_json"));
      }
    });

    req.on("error", (err) => {
      if (err && err.message === "payload_too_large") {
        finish(err);
        return;
      }
      finish(err || new Error("read_error"));
    });
  });
}

function trimString(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.slice(0, maxLength);
}

function normalizeLevel(value) {
  const normalized = trimString(value, 16).toLowerCase();
  return ALLOWED_LEVELS.has(normalized) ? normalized : "info";
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return {};
  }

  const normalized = {};
  for (const [key, value] of Object.entries(meta)) {
    const normalizedKey = trimString(key, 64);
    if (!normalizedKey) {
      continue;
    }
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      normalized[normalizedKey] = value;
      continue;
    }
    if (typeof value === "string") {
      normalized[normalizedKey] = value.slice(0, 500);
    }
  }
  return normalized;
}

function normalizeClientInfo(client) {
  if (!client || typeof client !== "object" || Array.isArray(client)) {
    return {};
  }
  return {
    appVersion: trimString(client.appVersion, 64),
    userAgent: trimString(client.userAgent, 500),
    platform: trimString(client.platform, 64),
  };
}

function normalizeSessionInfo(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return {};
  }
  return {
    requestId: trimString(session.requestId, 128),
  };
}

function validateLogEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { error: "invalid_log_entry" };
  }

  const logId = trimString(entry.logId, 128);
  const createdAt = trimString(entry.createdAt, 64);
  const event = trimString(entry.event, 128);
  const category = trimString(entry.category, 64);

  if (!logId) {
    return { error: "missing_log_id" };
  }
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
    return { error: "invalid_created_at", logId };
  }
  if (!event) {
    return { error: "missing_event", logId };
  }
  if (!category) {
    return { error: "missing_category", logId };
  }

  return {
    normalized: {
      logId,
      createdAt,
      event,
      category,
      level: normalizeLevel(entry.level),
      path: trimString(entry.path, 256),
      method: trimString(entry.method, 16).toUpperCase(),
      status: typeof entry.status === "number" ? entry.status : null,
      message: trimString(entry.message, 500),
      meta: normalizeMeta(entry.meta),
    },
  };
}

function createClientLogsHandler({ sendJson, LOG_DIR }) {
  const logFilePath = path.join(LOG_DIR, "client_logs.csv");
  const { appendLog } = createLogger(logFilePath, { maxBytes: CLIENT_LOG_MAX_BYTES });
  const seenLogIds = new Map();

  return async function handleClientLogs(req, res) {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const serverRequestId = createServerRequestId();

    if (requestUrl.pathname === "/api/client-logs/health") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        serverRequestId,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (requestUrl.pathname !== "/api/client-logs") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err && err.message === "payload_too_large") {
        sendJson(res, 413, { error: "payload_too_large", serverRequestId });
        return;
      }
      sendJson(res, 400, { error: "invalid_payload", serverRequestId });
      return;
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { error: "invalid_payload", serverRequestId });
      return;
    }

    if (!Array.isArray(body.logs)) {
      sendJson(res, 400, { error: "invalid_payload", serverRequestId });
      return;
    }

    if (body.logs.length === 0) {
      sendJson(res, 400, { error: "invalid_payload", serverRequestId });
      return;
    }

    const logs = body.logs.slice(0, MAX_LOGS_PER_REQUEST);
    const rejected = [];
    const duplicate = [];
    const accepted = [];
    const client = normalizeClientInfo(body.client);
    const session = normalizeSessionInfo(body.session);

    for (const entry of logs) {
      const result = validateLogEntry(entry);
      if (result.error) {
        rejected.push({
          logId: trimString(entry && entry.logId, 128),
          reason: result.error,
        });
        continue;
      }

      const normalized = result.normalized;
      if (seenLogIds.has(normalized.logId)) {
        duplicate.push(normalized.logId);
        continue;
      }

      seenLogIds.set(normalized.logId, Date.now());
      pruneSeenLogIds(seenLogIds);
      accepted.push(normalized.logId);
      appendLog(
        normalized.level.toUpperCase(),
        JSON.stringify({
          serverRequestId,
          receivedAt: new Date().toISOString(),
          client,
          session,
          log: normalized,
        })
      );
    }

    if (body.logs.length > MAX_LOGS_PER_REQUEST) {
      rejected.push({
        logId: "",
        reason: "too_many_logs",
      });
    }

    if (accepted.length === 0 && duplicate.length === 0) {
      sendJson(res, 400, {
        error: "invalid_payload",
        serverRequestId,
        accepted,
        duplicate,
        rejected,
      });
      return;
    }

    const statusCode = rejected.length > 0 ? 207 : 200;
    sendJson(res, statusCode, {
      ok: true,
      serverRequestId,
      accepted,
      duplicate,
      rejected,
    });
  };
}

module.exports = createClientLogsHandler;
