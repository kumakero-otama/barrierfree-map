const { createDbPool } = require("../db");
const { createLogger } = require("../logger");
const { resolveAuthenticatedUserId } = require("../auth_user");
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

  // /api/session/{start|end|cancel|deactivate} を1つのハンドラで振り分ける。
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
        await handleSessionStart(req, data, res);
        return;
      }
      if (action === "end") {
        await handleSessionEnd(req, data, res);
        return;
      }
      if (action === "cancel") {
        await handleSessionCancel(req, data, res);
        return;
      }
      if (action === "deactivate") {
        await handleSessionDeactivate(req, data, res);
        return;
      }

      sendJson(res, 404, { error: "unknown_action" });
    });
  };

  // セッション開始時刻を作成/更新する。
  async function handleSessionStart(req, data, res) {
    const sessionId = data.sessionId || data.sessionUuid;
    const startedAt = data.startedAt || new Date().toISOString();

    if (!sessionId) {
      sendJson(res, 400, { error: "missing_session_id" });
      return;
    }

    if (!pool) {
      sendJson(res, 200, { success: true, sessionId, dbDisabled: true });
      return;
    }

    try {
      const userId = await resolveAuthenticatedUserId(req, pool);
      if (!userId) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      sessionLogger.appendLog("SESSION_START", `${sessionId},user_id=${userId},${startedAt}`);

      await pool.query(
        `INSERT INTO tactile.sessions (session_id, user_id, started_at, ended_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT (session_id) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               started_at = EXCLUDED.started_at
         RETURNING session_id`,
        [sessionId, userId, startedAt]
      );
      sendJson(res, 200, { success: true, sessionId });
    } catch (err) {
      sessionLogger.appendLog("ERROR", `SESSION_START_DB_ERROR[${sessionId}]: ${err.message}`);
      sendJson(res, 500, { error: "session_start_failed", message: err.message });
    }
  }

  // セッション終了時刻を更新する。
  async function handleSessionEnd(req, data, res) {
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
      const userId = await resolveAuthenticatedUserId(req, pool);
      if (!userId) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const [result] = await pool.query(
        "UPDATE tactile.sessions SET ended_at = ? WHERE session_id = ? AND user_id = ?",
        [endedAt, sessionId, userId]
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

  // キャンセル対象セッションの関連データをまとめて削除する。
  async function handleSessionCancel(req, data, res) {
    const sessionId = data.sessionId || data.sessionUuid;

    if (!sessionId) {
      sendJson(res, 400, { error: "missing_session_id" });
      return;
    }

    if (!pool) {
      sendJson(res, 200, { success: true, sessionId, dbDisabled: true });
      return;
    }

    try {
      const userId = await resolveAuthenticatedUserId(req, pool);
      if (!userId) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (canceledSessionIds) {
        canceledSessionIds.add(sessionId);
      }
      if (deletedSessionKeys) {
        deletedSessionKeys.add(`${sessionId}:${userId}`);
      }
      sessionLogger.appendLog("SESSION_CANCEL", `${sessionId},user_id=${userId}`);

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [targetRows] = await conn.query(
          "SELECT session_id FROM tactile.sessions WHERE session_id = ? AND user_id = ? LIMIT 1",
          [sessionId, userId]
        );
        if (!Array.isArray(targetRows) || targetRows.length < 1) {
          throw new Error("session_not_found_or_forbidden");
        }
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
      if (err && err.message === "session_not_found_or_forbidden") {
        sendJson(res, 404, { error: "session_not_found_or_forbidden" });
        return;
      }
      sessionLogger.appendLog("ERROR", `SESSION_CANCEL_DB_ERROR[${sessionId}]: ${err.message}`);
      sendJson(res, 500, { error: "session_cancel_failed", message: err.message });
    }
  }

  // セッションを論理無効化し、一覧表示などから除外できるようにする。
  async function handleSessionDeactivate(req, data, res) {
    const sessionId = data.sessionId || data.sessionUuid;

    if (!sessionId) {
      sendJson(res, 400, { error: "missing_session_id" });
      return;
    }

    if (!pool) {
      sendJson(res, 200, { success: true, sessionId, dbDisabled: true });
      return;
    }

    try {
      const userId = await resolveAuthenticatedUserId(req, pool);
      if (!userId) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      sessionLogger.appendLog("SESSION_DEACTIVATE", `${sessionId},user_id=${userId}`);
      const [result] = await pool.query(
        "UPDATE tactile.sessions SET is_active = false WHERE session_id = ? AND user_id = ?",
        [sessionId, userId]
      );
      const updated = result.affectedRows || 0;
      if (updated < 1) {
        sendJson(res, 404, { error: "session_not_found_or_forbidden" });
        return;
      }

      sendJson(res, 200, {
        success: true,
        sessionId,
        updated,
      });
    } catch (err) {
      sessionLogger.appendLog("ERROR", `SESSION_DEACTIVATE_DB_ERROR[${sessionId}]: ${err.message}`);
      sendJson(res, 500, { error: "session_deactivate_failed", message: err.message });
    }
  }
}

module.exports = createSessionHandler;
