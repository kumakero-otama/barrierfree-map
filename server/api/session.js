const { createDbPool } = require("../db");
const { createLogger } = require("../logger");
const { resolveAuthenticatedUserId } = require("../auth_user");
const path = require("path");

// セッション開始・終了・キャンセル・論理削除・メモ更新を集約した API を作る。
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

  async function refreshUserTactileLength(conn, userId) {
    const safeUserId = Number(userId);
    if (!Number.isFinite(safeUserId) || safeUserId <= 0) {
      return;
    }

    await conn.query(
      `UPDATE login.users
       SET total_tactile_length = COALESCE((
             SELECT (COALESCE(SUM(ST_Length(sp.geom)), 0) / 1000.0)::numeric(10,3)
             FROM tactile.sessions s
             JOIN tactile.session_paths sp
               ON sp.session_id = s.session_id
             WHERE s.user_id = ?
               AND s.is_active = true
           ), 0),
           updated_at = NOW()
       WHERE user_id = ?`,
      [safeUserId, safeUserId]
    );
  }

  // /api/session/{start|point|end|cancel|deactivate|memo} を1つのハンドラで振り分ける。
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
        // 開始処理は upsert なので、途中再送が来ても同じ入口で吸収できる。
        await handleSessionStart(req, data, res);
        return;
      }
      if (action === "point") {
        await handleSessionPoint(req, data, res);
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
      if (action === "memo") {
        await handleSessionMemo(req, data, res);
        return;
      }

      sendJson(res, 404, { error: "unknown_action" });
    });
  };

  // 別画面へ移動している間も、Valhallaを介さずGPS生座標だけを追記する。
  // フィッティング済み座標とWayは、記録終了時にブラウザ版の結果で確定する。
  async function handleSessionPoint(req, data, res) {
    const sessionId = data.sessionId || data.sessionUuid;
    const lat = Number(data.lat);
    const lng = Number(data.lng);
    const accuracy = data.accuracy == null ? null : Number(data.accuracy);
    const recordedAt = data.recordedAt || new Date().toISOString();
    if (!sessionId) {
      sendJson(res, 400, { error: "missing_session_id" });
      return;
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 ||
        !Number.isFinite(lng) || lng < -180 || lng > 180 ||
        (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0))) {
      sendJson(res, 400, { error: "invalid_gps_point" });
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
      if (canceledSessionIds && canceledSessionIds.has(sessionId)) {
        sendJson(res, 409, { error: "session_canceled" });
        return;
      }
      const [owned] = await pool.query(
        "SELECT session_id FROM tactile.sessions WHERE session_id=? AND user_id=? LIMIT 1",
        [sessionId, userId]
      );
      if (!owned[0]) {
        sendJson(res, 404, { error: "session_not_found_or_forbidden" });
        return;
      }
      await pool.query(
        `INSERT INTO tactile.gps_raw(session_id,ts,geom,accuracy)
         VALUES(?,?,ST_SetSRID(ST_MakePoint(?,?),4326)::geography,?)`,
        [sessionId, recordedAt, lng, lat, accuracy]
      );
      sendJson(res, 200, { success: true, sessionId, stored: true });
    } catch (err) {
      sessionLogger.appendLog("ERROR", `SESSION_POINT_DB_ERROR[${sessionId}]: ${err.message}`);
      sendJson(res, 500, { error: "session_point_failed" });
    }
  }

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
        // 所有者本人のセッションだけ終了時刻を更新する。
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
        // 別 API からの後追い保存を止めるため、先にキャンセル済み集合へ登録する。
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
          "SELECT session_id, user_id FROM tactile.sessions WHERE session_id = ? AND user_id = ? LIMIT 1",
          [sessionId, userId]
        );
        if (!Array.isArray(targetRows) || targetRows.length < 1) {
          throw new Error("session_not_found_or_forbidden");
        }
        // 関連データを順に消し、最後に sessions 本体を削除して整合性を保つ。
        await conn.query("DELETE FROM tactile.session_path_edges WHERE session_id = ?", [sessionId]);
        await conn.query("DELETE FROM tactile.session_paths WHERE session_id = ?", [sessionId]);
        await conn.query("DELETE FROM tactile.gps_matched WHERE session_id = ?", [sessionId]);
        await conn.query("DELETE FROM tactile.gps_raw WHERE session_id = ?", [sessionId]);
        await conn.query("DELETE FROM tactile.sessions WHERE session_id = ?", [sessionId]);
        await refreshUserTactileLength(conn, userId);
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
      const conn = await pool.getConnection();
      let updated = 0;
      try {
        await conn.beginTransaction();
        // 論理削除として is_active を落とし、表示・集計対象から外す。
        const [result] = await conn.query(
          "UPDATE tactile.sessions SET is_active = false WHERE session_id = ? AND user_id = ?",
          [sessionId, userId]
        );
        updated = result.affectedRows || 0;
        if (updated < 1) {
          await conn.rollback();
          sendJson(res, 404, { error: "session_not_found_or_forbidden" });
          return;
        }
        await refreshUserTactileLength(conn, userId);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
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

  // セッションメモを上書き更新する。
  async function handleSessionMemo(req, data, res) {
    const sessionId = data.sessionId || data.sessionUuid;
    const memo = typeof data.memo === "string" ? data.memo : null;

    if (!sessionId) {
      sendJson(res, 400, { error: "missing_session_id" });
      return;
    }
    if (memo == null) {
      sendJson(res, 400, { error: "missing_memo" });
      return;
    }

    if (!pool) {
      sendJson(res, 200, { success: true, sessionId, memo, dbDisabled: true });
      return;
    }

    try {
      const userId = await resolveAuthenticatedUserId(req, pool);
      if (!userId) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      sessionLogger.appendLog("SESSION_MEMO", `${sessionId},user_id=${userId}`);
      // メモ更新は単一 UPDATE に限定し、所有者一致しない場合は 404 にする。
      const [result] = await pool.query(
        "UPDATE tactile.sessions SET memo = ? WHERE session_id = ? AND user_id = ?",
        [memo, sessionId, userId]
      );
      const updated = result.affectedRows || 0;
      if (updated < 1) {
        sendJson(res, 404, { error: "session_not_found_or_forbidden" });
        return;
      }

      sendJson(res, 200, {
        success: true,
        sessionId,
        memo,
        updated,
      });
    } catch (err) {
      sessionLogger.appendLog("ERROR", `SESSION_MEMO_DB_ERROR[${sessionId}]: ${err.message}`);
      sendJson(res, 500, { error: "session_memo_failed", message: err.message });
    }
  }
}

module.exports = createSessionHandler;
