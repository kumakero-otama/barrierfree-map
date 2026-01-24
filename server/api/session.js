const { createDbPool } = require("../db");
const { createLogger } = require("../logger");
const path = require("path");

function createSessionHandler({ sendJson }) {
  const dbResult = createDbPool();
  const pool = dbResult.pool;
  const dbError = dbResult.error;

  // セッション専用ログファイル
  const LOG_DIR = path.join(__dirname, "..", "..", "logs");
  const SESSION_LOG = path.join(LOG_DIR, "sessions.csv");
  const POINTS_LOG = path.join(LOG_DIR, "session_points.csv");
  
  const sessionLogger = createLogger(SESSION_LOG);
  const pointsLogger = createLogger(POINTS_LOG);

  if (dbError) {
    const errorMsg = `DB初期化失敗: ${dbError.message}`;
    console.warn("session_handler_db_init_failed", errorMsg);
    sessionLogger.appendLog("ERROR", errorMsg);
  } else if (!pool) {
    const errorMsg = "DBプールが作成されませんでした";
    console.warn("session_handler_no_pool", errorMsg);
    sessionLogger.appendLog("ERROR", errorMsg);
  } else {
    sessionLogger.appendLog("INFO", "DB接続成功");
  }

  return async function handleSession(req, res) {
    // Parse request path to determine action
    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.pathname.split("/").pop(); // start, point, end

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    // Read request body
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", async () => {
      try {
        const data = JSON.parse(body);

        if (action === "start") {
          await handleSessionStart(data, res);
        } else if (action === "point") {
          await handleSessionPoint(data, res);
        } else if (action === "end") {
          await handleSessionEnd(data, res);
        } else {
          sendJson(res, 404, { error: "unknown_action" });
        }
      } catch (err) {
        console.error("session_handler_error", err.message);
        sendJson(res, 400, { error: "invalid_request" });
      }
    });
  };

  async function handleSessionStart(data, res) {
    const { sessionUuid, userId } = data;

    if (!sessionUuid || !userId) {
      sendJson(res, 400, { error: "missing_params" });
      return;
    }

    // CSVログに記録（DBの状態に関わらず）
    sessionLogger.appendLog("SESSION_START", `${sessionUuid},${userId}`);

    // DB接続がない場合はCSVのみ
    if (!pool) {
      sendJson(res, 200, {
        success: true,
        sessionId: null,
        sessionUuid,
        dbDisabled: true,
      });
      return;
    }

    try {
      const [result] = await pool.query(
        "INSERT INTO sessions (session_uuid, user_id) VALUES (?, ?)",
        [sessionUuid, userId]
      );

      sendJson(res, 200, {
        success: true,
        sessionId: result.insertId,
        sessionUuid,
      });
    } catch (err) {
      const errorMsg = `セッション開始DBエラー[${sessionUuid}]: ${err.message} (code: ${err.code})`;
      console.error("session_start_error", errorMsg);
      sessionLogger.appendLog("ERROR", errorMsg);
      
      // DBエラーでもCSVには記録されているので成功として扱う
      if (err.code === "ER_DUP_ENTRY") {
        sendJson(res, 409, { error: "session_already_exists" });
      } else {
        sendJson(res, 200, {
          success: true,
          sessionId: null,
          sessionUuid,
          dbError: true,
        });
      }
    }
  }

  async function handleSessionPoint(data, res) {
    const { sessionUuid, lat, lng, seq } = data;

    if (!sessionUuid || lat === undefined || lng === undefined || seq === undefined) {
      sendJson(res, 400, { error: "missing_params" });
      return;
    }

    // CSVログに記録（DBの状態に関わらず）
    pointsLogger.appendLog("POINT", `${sessionUuid},${seq},${lat},${lng}`);

    // DB接続がない場合はCSVのみ
    if (!pool) {
      sendJson(res, 200, { success: true, dbDisabled: true });
      return;
    }

    try {
      // Get session_id from session_uuid
      const [sessions] = await pool.query(
        "SELECT id FROM sessions WHERE session_uuid = ? AND ended_at IS NULL",
        [sessionUuid]
      );

      if (sessions.length === 0) {
        // DBで見つからなくてもCSVには記録されているので成功として扱う
        sendJson(res, 200, { success: true, dbError: true });
        return;
      }

      const sessionId = sessions[0].id;

      // Insert point
      await pool.query(
        "INSERT INTO session_points (session_id, seq, lat, lng) VALUES (?, ?, ?, ?)",
        [sessionId, seq, lat, lng]
      );

      sendJson(res, 200, { success: true });
    } catch (err) {
      const errorMsg = `ポイント記録DBエラー[${sessionUuid},seq:${seq}]: ${err.message} (code: ${err.code})`;
      console.error("session_point_error", errorMsg);
      pointsLogger.appendLog("ERROR", errorMsg);
      
      // DBエラーでもCSVには記録されているので成功として扱う
      sendJson(res, 200, { success: true, dbError: true });
    }
  }

  async function handleSessionEnd(data, res) {
    const { sessionUuid, note } = data;

    if (!sessionUuid) {
      sendJson(res, 400, { error: "missing_params" });
      return;
    }

    // CSVログに記録（DBの状態に関わらず）
    sessionLogger.appendLog("SESSION_END", `${sessionUuid},${note || ""}`);

    // DB接続がない場合はCSVのみ
    if (!pool) {
      sendJson(res, 200, { success: true, dbDisabled: true });
      return;
    }

    try {
      const [result] = await pool.query(
        "UPDATE sessions SET ended_at = CURRENT_TIMESTAMP, note = ? WHERE session_uuid = ? AND ended_at IS NULL",
        [note || null, sessionUuid]
      );

      if (result.affectedRows === 0) {
        // DBで見つからなくてもCSVには記録されているので成功として扱う
        sendJson(res, 200, { success: true, dbError: true });
        return;
      }

      sendJson(res, 200, { success: true });
    } catch (err) {
      const errorMsg = `セッション終了DBエラー[${sessionUuid}]: ${err.message} (code: ${err.code})`;
      console.error("session_end_error", errorMsg);
      sessionLogger.appendLog("ERROR", errorMsg);
      
      // DBエラーでもCSVには記録されているので成功として扱う
      sendJson(res, 200, { success: true, dbError: true });
    }
  }
}

module.exports = createSessionHandler;
