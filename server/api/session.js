const { createDbPool } = require("../db");
const { createLogger } = require("../logger");
const path = require("path");

function createSessionHandler({ sendJson, deletedSessionKeys, canceledSessionIds }) {
  const dbResult = createDbPool();
  const pool = dbResult.pool;
  const dbError = dbResult.error;

  const LOG_DIR = path.join(__dirname, "..", "..", "logs");
  const SESSION_LOG = path.join(LOG_DIR, "sessions.csv");
  const sessionLogger = createLogger(SESSION_LOG);

  if (dbError) {
    sessionLogger.appendLog("ERROR", `DB初期化失敗: ${dbError.message}`);
  } else if (!pool) {
    sessionLogger.appendLog("ERROR", "DBプールが作成されませんでした");
  } else {
    sessionLogger.appendLog("INFO", "DB接続成功");
  }

  return async function handleSession(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.pathname.split("/").pop();

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", async () => {
      let data;
      try {
        data = body ? JSON.parse(body) : {};
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }

      if (action === "start") {
        await handleSessionStart(data, res);
        return;
      }
      if (action === "end") {
        await handleSessionEnd(data, res);
        return;
      }
      if (action === "cancel") {
        await handleSessionCancel(data, res);
        return;
      }

      sendJson(res, 404, { error: "unknown_action" });
    });
  };

  async function handleSessionStart(data, res) {
    const sessionId = data.sessionId || data.sessionUuid;
    const deviceId = data.deviceId || data.deviceUuid || null;
    const startedAt = data.startedAt || new Date().toISOString();

    if (!sessionId) {
      sendJson(res, 400, { error: "missing_session_id" });
      return;
    }

    sessionLogger.appendLog("SESSION_START", `${sessionId},${deviceId || ""},${startedAt}`);

    if (!pool) {
      sendJson(res, 200, { success: true, sessionId, dbDisabled: true });
      return;
    }

    try {
      await pool.query(
        `INSERT INTO tactile.sessions (session_id, device_id, started_at, ended_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT (session_id) DO UPDATE
           SET device_id = EXCLUDED.device_id,
               started_at = EXCLUDED.started_at
         RETURNING session_id`,
        [sessionId, deviceId, startedAt]
      );
      sendJson(res, 200, { success: true, sessionId });
    } catch (err) {
      sessionLogger.appendLog("ERROR", `SESSION_START_DB_ERROR[${sessionId}]: ${err.message}`);
      sendJson(res, 500, { error: "session_start_failed", message: err.message });
    }
  }

  async function handleSessionEnd(data, res) {
    const sessionId = data.sessionId || data.sessionUuid;
    const endedAt = data.endedAt || new Date().toISOString();

    if (!sessionId) {
      sendJson(res, 400, { error: "missing_session_id" });
      return;
    }

    sessionLogger.appendLog("SESSION_END", `${sessionId},${endedAt}`);

    if (!pool) {
      sendJson(res, 200, { success: true, sessionId, dbDisabled: true });
      return;
    }

    try {
      const [result] = await pool.query(
        "UPDATE tactile.sessions SET ended_at = ? WHERE session_id = ?",
        [endedAt, sessionId]
      );
      sendJson(res, 200, {
        success: true,
        sessionId,
        updated: result.affectedRows || 0,
      });
    } catch (err) {
      sessionLogger.appendLog("ERROR", `SESSION_END_DB_ERROR[${sessionId}]: ${err.message}`);
      sendJson(res, 500, { error: "session_end_failed", message: err.message });
    }
  }

  async function handleSessionCancel(data, res) {
    const sessionId = data.sessionId || data.sessionUuid;
    const deviceId = data.deviceId || data.deviceUuid || null;

    if (!sessionId) {
      sendJson(res, 400, { error: "missing_session_id" });
      return;
    }

    if (canceledSessionIds) {
      canceledSessionIds.add(sessionId);
    }
    if (deletedSessionKeys && deviceId) {
      deletedSessionKeys.add(`${sessionId}:${deviceId}`);
    }
    sessionLogger.appendLog("SESSION_CANCEL", `${sessionId},${deviceId || ""}`);

    if (!pool) {
      sendJson(res, 200, { success: true, sessionId, dbDisabled: true });
      return;
    }

    try {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query("DELETE FROM tactile.session_path_edges WHERE session_id = ?", [sessionId]);
        await conn.query("DELETE FROM tactile.session_paths WHERE session_id = ?", [sessionId]);
        await conn.query("DELETE FROM tactile.gps_matched WHERE session_id = ?", [sessionId]);
        await conn.query("DELETE FROM tactile.gps_raw WHERE session_id = ?", [sessionId]);
        await conn.query("DELETE FROM tactile.sessions WHERE session_id = ?", [sessionId]);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }

      sendJson(res, 200, { success: true, sessionId, canceled: true });
    } catch (err) {
      sessionLogger.appendLog("ERROR", `SESSION_CANCEL_DB_ERROR[${sessionId}]: ${err.message}`);
      sendJson(res, 500, { error: "session_cancel_failed", message: err.message });
    }
  }
}

module.exports = createSessionHandler;
