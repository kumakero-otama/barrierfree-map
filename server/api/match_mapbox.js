const { createDbPool } = require("../db");
const { createLogger } = require("../logger");
const path = require("path");

function createMatchHandler({
  https,
  MAPBOX_TOKEN,
  MIN_INTERVAL_MS,
  MAX_MATCH_CALLS_PER_MONTH,
  lastRequestByDevice,
  getCurrentMonth,
  getMonthlyCount,
  incrementMonthlyCount,
  deletedSessionKeys,
  canceledSessionIds,
  sendJson,
}) {
  // DB接続とロガー
  const dbResult = createDbPool();
  const pool = dbResult.pool;
  
  const LOG_DIR = path.join(__dirname, "..", "..", "logs");
  const SESSION_LOG = path.join(LOG_DIR, "sessions.csv");
  const POINTS_LOG = path.join(LOG_DIR, "session_points.csv");
  
  const sessionLogger = createLogger(SESSION_LOG);
  const pointsLogger = createLogger(POINTS_LOG);
  
  // セッション更新関数（存在しなければ作成、存在すれば終了時刻を更新）
  async function updateSession(sessionUuid, userId, snappedLat, snappedLng, seq) {
    console.log(`[updateSession] Called with: sessionUuid=${sessionUuid}, userId=${userId}, seq=${seq}, pool=${!!pool}`);
    
    if (!sessionUuid || !userId || !pool) {
      console.log(`[updateSession] Skipped: sessionUuid=${!!sessionUuid}, userId=${!!userId}, pool=${!!pool}`);
      return; // sessionUuidがないまたはDBが利用不可の場合はスキップ
    }
    const deleteKey = `${sessionUuid}:${userId}`;
    if (deletedSessionKeys && deletedSessionKeys.has(deleteKey)) {
      sessionLogger.appendLog("SESSION_SKIP_DELETED", deleteKey);
      console.log(`[updateSession] Session was deleted: ${deleteKey}`);
      return;
    }
    const safeUserId = userId || "unknown";
    
    // CSVログに記録
    sessionLogger.appendLog("SESSION_UPDATE", `${sessionUuid},${safeUserId}`);
    pointsLogger.appendLog("POINT", `${sessionUuid},${seq},${snappedLat},${snappedLng}`);
    console.log(`[updateSession] Logged to CSV: sessionUuid=${sessionUuid}, seq=${seq}`);
    
    try {
      // セッションが存在するかチェック
      const [sessions] = await pool.query(
        "SELECT id FROM tactile.sessions WHERE session_uuid = ?",
        [sessionUuid]
      );
      
      if (sessions.length === 0) {
        // 新規セッション作成
        const [result] = await pool.query(
          "INSERT INTO tactile.sessions (session_uuid, user_id, started_at, ended_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          [sessionUuid, safeUserId]
        );
        
        const sessionId = result.insertId;
        sessionLogger.appendLog("SESSION_START", `${sessionUuid},${safeUserId},session_id=${sessionId}`);
        
        // ポイントを保存
        await pool.query(
          "INSERT INTO tactile.session_points (session_id, seq, lat, lng) VALUES (?, ?, ?, ?)",
          [sessionId, seq, snappedLat, snappedLng]
        );
      } else {
        // 既存セッションの終了時刻を更新
        const sessionId = sessions[0].id;
        await pool.query(
          "UPDATE tactile.sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?",
          [sessionId]
        );
        
        // ポイントを保存
        await pool.query(
          "INSERT INTO tactile.session_points (session_id, seq, lat, lng) VALUES (?, ?, ?, ?)",
          [sessionId, seq, snappedLat, snappedLng]
        );
      }
    } catch (err) {
      const errorMsg = `セッション更新エラー[${sessionUuid}]: ${err.message}`;
      sessionLogger.appendLog("ERROR", errorMsg);
    }
  }
  
  function sendNoContent(res) {

    res.writeHead(204);
    res.end();
  }

  return function handleMatch(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!MAPBOX_TOKEN) {
      sendJson(res, 500, { error: "missing_mapbox_token" });
      return;
    }
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const lat = parseFloat(url.searchParams.get("lat"));
    const lng = parseFloat(url.searchParams.get("lng"));
    const sessionUuid = url.searchParams.get("sessionUuid");
    const userId = url.searchParams.get("userId");
    const deviceUuid = url.searchParams.get("deviceUuid") || userId;
    const seq = parseInt(url.searchParams.get("seq"), 10);

    const currentMonth = getCurrentMonth();
    const currentCount = getMonthlyCount(currentMonth);

    if (currentCount >= MAX_MATCH_CALLS_PER_MONTH) {
      sendNoContent(res);
      return;
    }
    const prevLat = parseFloat(url.searchParams.get("prevLat"));
    const prevLng = parseFloat(url.searchParams.get("prevLng"));

    const ip = req.socket.remoteAddress || "unknown";
    console.log(`raw_lat=${lat}, raw_lng=${lng}, ip=${ip}`);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      sendJson(res, 400, { error: "invalid_coordinates" });
      return;
    }

    const now = Date.now();
    const rateLimitKey = deviceUuid || ip;
    const last = lastRequestByDevice.get(rateLimitKey) || 0;
    if (now - last < MIN_INTERVAL_MS) {
      sendJson(res, 429, { error: "rate_limited", retryAfterMs: MIN_INTERVAL_MS - (now - last) });
      return;
    }
    lastRequestByDevice.set(rateLimitKey, now);

    let coords;
    if (!Number.isFinite(prevLat) || !Number.isFinite(prevLng)) {
      // 初回リクエスト時は、同じ座標を2回送信して道路にスナップ
      coords = `${lng},${lat};${lng},${lat}`;
      console.log(`match request (first time): lat=${lat}, lng=${lng}`);
    } else {
      coords = `${prevLng},${prevLat};${lng},${lat}`;
      console.log(`match request: lat=${lat}, lng=${lng}, prevLat=${prevLat}, prevLng=${prevLng}`);
    }

    console.log(`send_lat=${lat}, send_lng=${lng}`);
    const matchUrl = new URL(
      `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}`
    );
    matchUrl.searchParams.set("access_token", MAPBOX_TOKEN);
    matchUrl.searchParams.set("geometries", "geojson");
    matchUrl.searchParams.set("overview", "full");
    matchUrl.searchParams.set("steps", "false");
    matchUrl.searchParams.set("radiuses", "25;25");
    matchUrl.searchParams.set("tidy", "false");
    console.log(`mapbox_request_url=${matchUrl.toString()}`);

    incrementMonthlyCount(currentMonth);
    const newCount = getMonthlyCount(currentMonth);
    https
      .get(matchUrl, (apiRes) => {
        let body = "";
        apiRes.on("data", (chunk) => {
          body += chunk;
        });
        apiRes.on("end", () => {
          console.log(`mapbox_response_status=${apiRes.statusCode || 0}`);
          // mapbox_response_bodyログを削除（500バイト超のJSON出力によるI/O負荷削減）
          // console.log(`mapbox_response_body=${body}`);
          try {
            const data = JSON.parse(body);
            const tracepoints = Array.isArray(data.tracepoints) ? data.tracepoints : [];
            const lastPoint = tracepoints[tracepoints.length - 1];
            console.log(
              `mapbox_tracepoints_count=${tracepoints.length}, has_last_point=${Boolean(
                lastPoint && Array.isArray(lastPoint.location)
              )}`
            );
          if (lastPoint && Array.isArray(lastPoint.location)) {
            const [snappedLng, snappedLat] = lastPoint.location;
            console.log(`mapbox_snapped_lat=${snappedLat}, mapbox_snapped_lng=${snappedLng}`);
            
            // デバッグログ追加
            console.log(`[DEBUG] sessionUuid=${sessionUuid}, userId=${userId}, seq=${seq}, pool=${!!pool}`);
            console.log(`[DEBUG] condition check: sessionUuid=${!!sessionUuid}, userId=${!!userId}, isFiniteSeq=${Number.isFinite(seq)}`);
            
            // セッション更新（非同期だが待たない）
            if (sessionUuid && canceledSessionIds && canceledSessionIds.has(sessionUuid)) {
              console.log(`[DEBUG] Session canceled, skip updateSession: ${sessionUuid}`);
            } else if (sessionUuid && userId && Number.isFinite(seq)) {
              console.log(`[DEBUG] Calling updateSession...`);
              updateSession(sessionUuid, userId, snappedLat, snappedLng, seq).catch(err => {
                console.error('updateSession error:', err);
              });
            } else {
              console.log(`[DEBUG] updateSession NOT called: sessionUuid=${!!sessionUuid}, userId=${!!userId}, seq=${seq}`);
            }
            
            sendJson(res, 200, { lat: snappedLat, lng: snappedLng, count: newCount, month: currentMonth });
            return;
          }
        } catch {
          // fall through to fallback
        }
        sendNoContent(res);
      });
    })
    .on("error", (err) => {
      console.log(`mapbox_response_error=${err.message}`);
      sendNoContent(res);
    });
  };
}

module.exports = createMatchHandler;
