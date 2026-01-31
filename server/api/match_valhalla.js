const { createDbPool } = require("../db");
const { createLogger } = require("../logger");
const path = require("path");
const http = require("http");

function createMatchHandler({
  MIN_INTERVAL_MS,
  MAX_MATCH_CALLS_PER_MONTH,
  lastRequestByDevice,
  getCurrentMonth,
  getMonthlyCount,
  incrementMonthlyCount,
  deletedSessionKeys,
  sendJson,
}) {
  // Valhalla設定（環境変数または固定値）
  const VALHALLA_HOST = process.env.VALHALLA_HOST || "localhost";
  const VALHALLA_PORT = process.env.VALHALLA_PORT || "8002";
  
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
        "SELECT id FROM sessions WHERE session_uuid = ?",
        [sessionUuid]
      );
      
      if (sessions.length === 0) {
        // 新規セッション作成
        const [result] = await pool.query(
          "INSERT INTO sessions (session_uuid, user_id, started_at, ended_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
          [sessionUuid, safeUserId]
        );
        
        const sessionId = result.insertId;
        sessionLogger.appendLog("SESSION_START", `${sessionUuid},${safeUserId},session_id=${sessionId}`);
        
        // ポイントを保存
        await pool.query(
          "INSERT INTO session_points (session_id, seq, lat, lng) VALUES (?, ?, ?, ?)",
          [sessionId, seq, snappedLat, snappedLng]
        );
      } else {
        // 既存セッションの終了時刻を更新
        const sessionId = sessions[0].id;
        await pool.query(
          "UPDATE sessions SET ended_at = CURRENT_TIMESTAMP WHERE id = ?",
          [sessionId]
        );
        
        // ポイントを保存
        await pool.query(
          "INSERT INTO session_points (session_id, seq, lat, lng) VALUES (?, ?, ?, ?)",
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

    // Valhallaのtrace_attributesエンドポイントにPOSTリクエストを送る
    let shapePoints;
    if (!Number.isFinite(prevLat) || !Number.isFinite(prevLng)) {
      // 初回リクエスト時は、同じ座標を2回送信して道路にスナップ
      shapePoints = [
        { lat, lon: lng },
        { lat, lon: lng }
      ];
      console.log(`valhalla match request (first time): lat=${lat}, lng=${lng}`);
    } else {
      shapePoints = [
        { lat: prevLat, lon: prevLng },
        { lat, lon: lng }
      ];
      console.log(`valhalla match request: lat=${lat}, lng=${lng}, prevLat=${prevLat}, prevLng=${prevLng}`);
    }

    // Valhallaのリクエストボディ
    const valhallaRequest = {
      shape: shapePoints,
      costing: "pedestrian",
      shape_match: "map_snap",
      filters: {
        attributes: ["edge.id", "shape"],
        action: "include"
      }
    };

    const requestBody = JSON.stringify(valhallaRequest);
    console.log(`valhalla_request_body=${requestBody}`);

    const options = {
      hostname: VALHALLA_HOST,
      port: VALHALLA_PORT,
      path: "/trace_attributes",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(requestBody)
      }
    };

    incrementMonthlyCount(currentMonth);
    const newCount = getMonthlyCount(currentMonth);
    
    const valhallaReq = http.request(options, (apiRes) => {
      let body = "";
      apiRes.on("data", (chunk) => {
        body += chunk;
      });
      apiRes.on("end", () => {
        console.log(`valhalla_response_status=${apiRes.statusCode || 0}`);
        try {
          const data = JSON.parse(body);
          
          // Valhallaのレスポンスから最後のマッチポイントを取得
          // trace_attributesは matched_points を返す
          if (data.matched_points && Array.isArray(data.matched_points) && data.matched_points.length > 0) {
            const lastPoint = data.matched_points[data.matched_points.length - 1];
            if (lastPoint && typeof lastPoint.lat === "number" && typeof lastPoint.lon === "number") {
              const snappedLat = lastPoint.lat;
              const snappedLng = lastPoint.lon;
              console.log(`valhalla_snapped_lat=${snappedLat}, valhalla_snapped_lng=${snappedLng}`);
              
              // デバッグログ追加
              console.log(`[DEBUG] sessionUuid=${sessionUuid}, userId=${userId}, seq=${seq}, pool=${!!pool}`);
              console.log(`[DEBUG] condition check: sessionUuid=${!!sessionUuid}, userId=${!!userId}, isFiniteSeq=${Number.isFinite(seq)}`);
              
              // セッション更新（非同期だが待たない）
              if (sessionUuid && userId && Number.isFinite(seq)) {
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
          }
          
          console.log(`valhalla_response: no valid matched points`);
        } catch (err) {
          console.log(`valhalla_parse_error=${err.message}`);
        }
        sendNoContent(res);
      });
    });

    valhallaReq.on("error", (err) => {
      console.log(`valhalla_request_error=${err.message}`);
      sendNoContent(res);
    });

    valhallaReq.write(requestBody);
    valhallaReq.end();
  };
}

module.exports = createMatchHandler;
