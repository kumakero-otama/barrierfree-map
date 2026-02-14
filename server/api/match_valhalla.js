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
  canceledSessionIds,
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
  let realtimeSchemaChecked = false;
  
  // セッション更新関数（存在しなければ作成、存在すれば終了時刻を更新）
  async function updateSession(sessionUuid, userId, snappedLat, snappedLng, seq, logPrefix = "") {
    console.log(`${logPrefix} [updateSession] Called with: sessionUuid=${sessionUuid}, userId=${userId}, seq=${seq}, pool=${!!pool}`);
    
    if (!sessionUuid || !userId || !pool) {
      console.log(`${logPrefix} [updateSession] Skipped: sessionUuid=${!!sessionUuid}, userId=${!!userId}, pool=${!!pool}`);
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

  async function ensureRealtimeSchema() {
    if (!pool || realtimeSchemaChecked) {
      return;
    }
    try {
      await pool.query("SELECT session_id, ts, geom, accuracy FROM gps_raw LIMIT 1");
      await pool.query("SELECT session_id, ts, geom, edge_id, confidence FROM gps_matched LIMIT 1");
      realtimeSchemaChecked = true;
      console.log("[realtime_record] schema check passed: gps_raw, gps_matched");
    } catch (err) {
      console.error("[realtime_record] schema check failed:", err.message);
    }
  }

  async function persistRealtimePoints({ sessionUuid, rawLat, rawLng, snappedLat, snappedLng, edgeId, confidence, logPrefix }) {
    if (!pool) {
      return;
    }
    await ensureRealtimeSchema();
    if (!realtimeSchemaChecked) {
      return;
    }
    if (!sessionUuid) {
      console.warn(`${logPrefix || ""} [realtime_record] skipped: missing session_id`);
      return;
    }
    const safeSessionUuid = sessionUuid;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rawResult] = await conn.query(
        "INSERT INTO gps_raw (session_id, ts, geom, accuracy) VALUES (?, NOW(), ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)",
        [safeSessionUuid, rawLng, rawLat, null]
      );
      await conn.query(
        "INSERT INTO gps_matched (session_id, ts, geom, edge_id, confidence) VALUES (?, NOW(), ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?, ?)",
        [safeSessionUuid, snappedLng, snappedLat, edgeId || null, confidence ?? null]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
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
    const sessionUuid = url.searchParams.get("sessionId") || url.searchParams.get("sessionUuid");
    const userId = url.searchParams.get("userId");
    const deviceUuid = url.searchParams.get("deviceUuid") || userId;
    const shouldRecordRealtime = url.searchParams.get("record") === "1";
    const seq = parseInt(url.searchParams.get("seq"), 10);

    const currentMonth = getCurrentMonth();
    const currentCount = getMonthlyCount(currentMonth);

    if (currentCount >= MAX_MATCH_CALLS_PER_MONTH) {
      sendNoContent(res);
      return;
    }
    const prevLat = parseFloat(url.searchParams.get("prevLat"));
    const prevLng = parseFloat(url.searchParams.get("prevLng"));

    const ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";
    const logPrefix = `[User:${deviceUuid || userId || "unknown"} / IP:${ip}]`;
    console.log(`${logPrefix} raw_lat=${lat}, raw_lng=${lng}`);

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

    // Valhallaのlocateエンドポイントにリクエストを送る
    console.log(`${logPrefix} valhalla locate request: lat=${lat}, lng=${lng}`);

    // Valhallaのリクエストボディ（locateエンドポイント用）
    const valhallaRequest = {
      locations: [{ lat, lon: lng }],
      costing: "pedestrian"
    };

    const requestBody = JSON.stringify(valhallaRequest);
    console.log(`${logPrefix} valhalla_request_body=${requestBody}`);

    const options = {
      hostname: VALHALLA_HOST,
      port: VALHALLA_PORT,
      path: "/locate",
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
        console.log(`${logPrefix} valhalla_response_status=${apiRes.statusCode || 0}`);
        try {
          const data = JSON.parse(body);
          console.log(`${logPrefix} valhalla_response_body=${body}`);
          
          // locateのレスポンスから座標を取得
          // locateは配列を返し、edges[0]にスナップされた座標が含まれる
          if (Array.isArray(data) && data.length > 0 && data[0]) {
            const result = data[0];
            if (result.edges && Array.isArray(result.edges) && result.edges.length > 0) {
              const edge = result.edges[0];
              if (typeof edge.correlated_lat === "number" && typeof edge.correlated_lon === "number") {
                const snappedLat = edge.correlated_lat;
                const snappedLng = edge.correlated_lon;
                console.log(`${logPrefix} valhalla_snapped: lat=${snappedLat}, lng=${snappedLng} (input: ${result.input_lat}, ${result.input_lon})`);
                
                // デバッグログ追加
                console.log(`${logPrefix} [DEBUG] sessionUuid=${sessionUuid}, userId=${userId}, seq=${seq}, pool=${!!pool}`);
                console.log(`${logPrefix} [DEBUG] condition check: sessionUuid=${!!sessionUuid}, userId=${!!userId}, isFiniteSeq=${Number.isFinite(seq)}`);
                
                // セッション更新（非同期だが待たない）
                if (sessionUuid && canceledSessionIds && canceledSessionIds.has(sessionUuid)) {
                  console.log(`${logPrefix} [DEBUG] Skipping save for canceled session=${sessionUuid}`);
                } else if (sessionUuid && userId && Number.isFinite(seq)) {
                  console.log(`${logPrefix} [DEBUG] Calling updateSession...`);
                  updateSession(sessionUuid, userId, snappedLat, snappedLng, seq, logPrefix).catch(err => {
                    console.error(`${logPrefix} updateSession error:`, err);
                  });
                } else {
                  console.log(`[DEBUG] updateSession NOT called: sessionUuid=${!!sessionUuid}, userId=${!!userId}, seq=${seq}`);
                }

                if (shouldRecordRealtime && (!sessionUuid || !canceledSessionIds || !canceledSessionIds.has(sessionUuid))) {
                  persistRealtimePoints({
                    sessionUuid,
                    rawLat: lat,
                    rawLng: lng,
                    snappedLat,
                    snappedLng,
                    edgeId: edge.way_id,
                    confidence: null,
                    logPrefix,
                  }).catch((err) => {
                    console.error(`${logPrefix} realtime_record_error:`, err.message);
                  });
                } else if (shouldRecordRealtime && sessionUuid) {
                  console.log(`${logPrefix} [DEBUG] Realtime record skipped for canceled session=${sessionUuid}`);
                }
                
                sendJson(res, 200, { lat: snappedLat, lng: snappedLng, count: newCount, month: currentMonth });
                return;
              }
            }
          }
          
          console.log(`${logPrefix} valhalla_response: no valid location found`);
        } catch (err) {
          console.log(`${logPrefix} valhalla_parse_error=${err.message}`);
        }
        sendNoContent(res);
      });
    });

    valhallaReq.on("error", (err) => {
      console.log(`${logPrefix} valhalla_request_error=${err.message}`);
      sendNoContent(res);
    });

    valhallaReq.write(requestBody);
    valhallaReq.end();
  };
}

module.exports = createMatchHandler;
