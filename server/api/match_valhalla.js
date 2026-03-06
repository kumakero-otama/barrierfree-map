const { createDbPool } = require("../db");
const { createLogger } = require("../logger");
const path = require("path");
const http = require("http");

const SIDEWALK_PRIORITY_RADIUS_METERS = 10;
const PEDESTRIAN_SIDEWALK_COSTING_OPTIONS = Object.freeze({
  // Valhallaはfactorが1未満だと優先、1超で回避する。
  walkway_factor: 0.1,
  sidewalk_factor: 0.1,
});

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

function extractEdgeWayId(edgeCandidate) {
  if (!edgeCandidate || typeof edgeCandidate !== "object") {
    return null;
  }
  const directWayId = Number(edgeCandidate.way_id);
  if (Number.isFinite(directWayId)) {
    return directWayId;
  }
  const nestedWayId = Number(edgeCandidate.edge_info && edgeCandidate.edge_info.way_id);
  if (Number.isFinite(nestedWayId)) {
    return nestedWayId;
  }
  return null;
}

function getCorrelatedPoint(edgeCandidate) {
  if (!edgeCandidate || typeof edgeCandidate !== "object") {
    return null;
  }
  const correlatedLat = toFiniteNumber(edgeCandidate.correlated_lat);
  const correlatedLon = toFiniteNumber(edgeCandidate.correlated_lon);
  if (correlatedLat === null || correlatedLon === null) {
    return null;
  }
  return { lat: correlatedLat, lon: correlatedLon };
}

function isTruthySidewalkTag(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "left" || normalized === "right" || normalized === "both" || normalized === "yes" || normalized === "true";
}

function isSidewalkLikeEdge(edgeCandidate) {
  if (!edgeCandidate || typeof edgeCandidate !== "object") {
    return false;
  }
  const edge = edgeCandidate.edge && typeof edgeCandidate.edge === "object" ? edgeCandidate.edge : edgeCandidate;
  if (isTruthySidewalkTag(edge.sidewalk)) {
    return true;
  }
  if (isTruthySidewalkTag(edge.sidewalk_left) || isTruthySidewalkTag(edge.sidewalk_right)) {
    return true;
  }
  const use = typeof edge.use === "string" ? edge.use.toLowerCase() : "";
  const classification = edge.classification && typeof edge.classification.classification === "string"
    ? edge.classification.classification.toLowerCase()
    : "";
  return use === "footway" ||
    use === "pedestrian" ||
    use === "path" ||
    use === "living_street" ||
    classification === "footway" ||
    classification === "pedestrian" ||
    classification === "path";
}

function selectPreferredEdge(edges, rawLat, rawLng) {
  if (!Array.isArray(edges) || edges.length < 1) {
    return null;
  }

  const candidates = edges
    .map((edgeCandidate) => {
      const point = getCorrelatedPoint(edgeCandidate);
      if (!point) {
        return null;
      }
      return {
        edge: edgeCandidate,
        lat: point.lat,
        lon: point.lon,
        distanceMeters: haversineDistanceMeters(rawLat, rawLng, point.lat, point.lon),
        sidewalkLike: isSidewalkLikeEdge(edgeCandidate),
      };
    })
    .filter(Boolean);

  if (candidates.length < 1) {
    return null;
  }

  const sidewalkCandidates = candidates
    .filter((candidate) => candidate.sidewalkLike && candidate.distanceMeters <= SIDEWALK_PRIORITY_RADIUS_METERS)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
  if (sidewalkCandidates.length > 0) {
    return { ...sidewalkCandidates[0], sidewalkPriorityApplied: true };
  }

  return { ...candidates[0], sidewalkPriorityApplied: false };
}

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
  // Valhalla接続先（環境変数で上書き可能）。
  const VALHALLA_HOST = process.env.VALHALLA_HOST || "localhost";
  const VALHALLA_PORT = process.env.VALHALLA_PORT || "8002";
  
  // DB接続とログ出力先を準備する。
  const dbResult = createDbPool();
  const pool = dbResult.pool;
  
  const LOG_DIR = path.join(__dirname, "..", "..", "logs");
  const SESSION_LOG = path.join(LOG_DIR, "sessions.csv");
  const POINTS_LOG = path.join(LOG_DIR, "session_points.csv");
  
  const sessionLogger = createLogger(SESSION_LOG);
  const pointsLogger = createLogger(POINTS_LOG);
  let realtimeSchemaChecked = false;
  
  // セッション情報を更新し、スナップ点を時系列で保存する。
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

  // リアルタイム保存に必要なテーブルの存在を一度だけ確認する。
  async function ensureRealtimeSchema() {
    if (!pool || realtimeSchemaChecked) {
      return;
    }
    try {
      await pool.query("SELECT session_id, ts, geom, accuracy FROM tactile.gps_raw LIMIT 1");
      await pool.query("SELECT session_id, ts, geom, edge_id, confidence FROM tactile.gps_matched LIMIT 1");
      realtimeSchemaChecked = true;
      console.log("[realtime_record] schema check passed: gps_raw, gps_matched");
    } catch (err) {
      console.error("[realtime_record] schema check failed:", err.message);
    }
  }

  // raw座標とsnapped座標を同一トランザクションで保存する。
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
        "INSERT INTO tactile.gps_raw (session_id, ts, geom, accuracy) VALUES (?, NOW(), ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)",
        [safeSessionUuid, rawLng, rawLat, null]
      );
      await conn.query(
        "INSERT INTO tactile.gps_matched (session_id, ts, geom, edge_id, confidence) VALUES (?, NOW(), ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?, ?)",
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
  
  // 更新データがない場合は204で返す。
  function sendNoContent(res) {
    res.writeHead(204);
    res.end();
  }

  // Valhalla /locate を呼び、地図上の最新スナップ座標を返す。
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

    // 端末単位の最小送信間隔を守る。
    const now = Date.now();
    const rateLimitKey = deviceUuid || ip;
    const last = lastRequestByDevice.get(rateLimitKey) || 0;
    if (now - last < MIN_INTERVAL_MS) {
      sendJson(res, 429, { error: "rate_limited", retryAfterMs: MIN_INTERVAL_MS - (now - last) });
      return;
    }
    lastRequestByDevice.set(rateLimitKey, now);

    // Valhalla locate に1点問い合わせして最寄り道路を取得する。
    console.log(`${logPrefix} valhalla locate request: lat=${lat}, lng=${lng}`);

    // Valhallaのリクエストボディ（locateエンドポイント用）
    const valhallaRequest = {
      verbose: true,
      locations: [{ lat, lon: lng, radius: SIDEWALK_PRIORITY_RADIUS_METERS }],
      costing: "pedestrian",
      costing_options: {
        pedestrian: {
          ...PEDESTRIAN_SIDEWALK_COSTING_OPTIONS,
        },
      },
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
              const selectedEdge = selectPreferredEdge(result.edges, lat, lng);
              if (selectedEdge) {
                const snappedLat = selectedEdge.lat;
                const snappedLng = selectedEdge.lon;
                const edgeWayId = extractEdgeWayId(selectedEdge.edge);
                console.log(
                  `${logPrefix} valhalla_snapped: lat=${snappedLat}, lng=${snappedLng} ` +
                  `(input: ${result.input_lat}, ${result.input_lon}), ` +
                  `distance_m=${selectedEdge.distanceMeters.toFixed(2)}, ` +
                  `sidewalk_priority=${selectedEdge.sidewalkPriorityApplied}`
                );
                
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
                    edgeId: edgeWayId,
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
