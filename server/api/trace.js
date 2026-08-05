const http = require("http");
const { createDbPool } = require("../db");

const SIDEWALK_PRIORITY_RADIUS_METERS = 10;
const PEDESTRIAN_SIDEWALK_COSTING_OPTIONS = Object.freeze({
  // Valhallaはfactorが1未満だと優先、1超で回避する。
  walkway_factor: 0.1,
  sidewalk_factor: 0.1,
});

// Valhallaのencoded polylineを [lat, lon] 配列へ戻す。
function decodePolyline(str, precision = 6) {
  if (typeof str !== "string" || str.length < 1) {
    return [];
  }

  const coordinates = [];
  const factor = 10 ** precision;
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < str.length) {
    let result = 0;
    let shift = 0;
    let byte = null;

    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < str.length + 1);

    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    result = 0;
    shift = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < str.length + 1);

    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    coordinates.push([lat / factor, lon / factor]);
  }

  return coordinates;
}

// traceレスポンスから保存用の座標列を取り出す。
function extractPersistCoordinates(data) {
  if (data && Array.isArray(data.edges) && data.edges.length > 0) {
    let allCoords = [];
    data.edges.forEach((edge) => {
      if (!edge || !edge.shape) {
        return;
      }
      const edgeCoords = decodePolyline(edge.shape, 6);
      if (allCoords.length > 0 && edgeCoords.length > 0) {
        const lastPoint = allCoords[allCoords.length - 1];
        const firstPoint = edgeCoords[0];
        if (lastPoint[0] === firstPoint[0] && lastPoint[1] === firstPoint[1]) {
          allCoords = allCoords.concat(edgeCoords.slice(1));
          return;
        }
      }
      allCoords = allCoords.concat(edgeCoords);
    });
    if (allCoords.length > 1) {
      return { coordinates: allCoords, sourceType: "edges.shape" };
    }
  }

  if (data && data.shape) {
    const decoded = decodePolyline(data.shape, 6);
    if (decoded.length > 1) {
      return { coordinates: decoded, sourceType: "shape" };
    }
  }

  const matchedPoints = Array.isArray(data && data.matched_points) ? data.matched_points : [];
  const fallbackCoords = matchedPoints
    .map((p) => [Number(p && p.lat), Number(p && p.lon)])
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
  if (fallbackCoords.length > 1) {
    return { coordinates: fallbackCoords, sourceType: "matched_points" };
  }

  return { coordinates: [], sourceType: "none" };
}

// 座標列から PostGISに保存できるLINESTRING WKTを組み立てる。
function createLinestringWkt(coordinates) {
  const coords = coordinates
    .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon))
    .map(([lat, lon]) => `${lon} ${lat}`);
  if (coords.length < 2) {
    return null;
  }
  return `SRID=4326;LINESTRING(${coords.join(",")})`;
}

// is_active=true のセッションに紐づく経路長だけを再集計して km で保存する。
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

// trace 結果から復元したラインと edge 列を、セッション単位の経路テーブルへ反映する。
async function persistSessionPath(pool, sessionId, source, data, logPrefix) {
  if (!pool || !sessionId) {
    return;
  }

  const edges = Array.isArray(data.edges) ? data.edges : [];
  const { coordinates, sourceType } = extractPersistCoordinates(data);
  const wkt = createLinestringWkt(coordinates);
  if (!wkt) {
    console.warn(`${logPrefix} skip path save: not enough shape coordinates`);
    return;
  }

  const validEdges = edges
    .map((edge) => Number(edge && edge.way_id))
    .filter((edgeId) => Number.isFinite(edgeId));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 本体のライン情報（session_paths）は upsert で更新する。
    await conn.query(
      `INSERT INTO tactile.session_paths (session_id, geom, source)
       VALUES (?, ST_GeogFromText(?), ?)
       ON CONFLICT (session_id) DO UPDATE
         SET geom = EXCLUDED.geom,
             source = EXCLUDED.source,
             created_at = NOW()
       RETURNING session_id`,
      [sessionId, wkt, source]
    );

    // 紐づくエッジ列は一旦削除して、Valhalla が返した順序で再作成する。
    await conn.query(
      "DELETE FROM tactile.session_path_edges WHERE session_id = ?",
      [sessionId]
    );

    // seq に通過順を保存しておくと、後で元 edge 列を再現しやすい。
    for (let i = 0; i < validEdges.length; i += 1) {
      await conn.query(
        "INSERT INTO tactile.session_path_edges (session_id, seq, edge_id) VALUES (?, ?, ?) RETURNING session_id",
        [sessionId, i + 1, validEdges[i]]
      );
    }

    const [sessionRows] = await conn.query(
      "SELECT user_id FROM tactile.sessions WHERE session_id = ? LIMIT 1",
      [sessionId]
    );
    const ownerUserId = Array.isArray(sessionRows) && sessionRows.length > 0
      ? Number(sessionRows[0].user_id)
      : null;

    if (Number.isFinite(ownerUserId) && ownerUserId > 0) {
      await refreshUserTactileLength(conn, ownerUserId);
    }

    await conn.commit();
    console.log(
      `${logPrefix} saved session_paths + session_path_edges: ` +
      `edges=${validEdges.length}, vertices=${coordinates.length}, line_source=${sourceType}`
    );
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function createTraceHandler({ sendJson, canceledSessionIds }) {
  const VALHALLA_HOST = process.env.VALHALLA_HOST || "localhost";
  const VALHALLA_PORT = process.env.VALHALLA_PORT || "8002";
  const dbResult = createDbPool();
  const pool = dbResult.pool;

  // Valhalla trace_attributesを呼び、必要ならDB保存も行う。
  return function handleTrace(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", async () => {
      let requestData;
      try {
        requestData = JSON.parse(body);
      } catch (err) {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }

      const ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";
      const userId = requestData.userId || "unknown";
      const sessionId = requestData.sessionId || null;
      const source = requestData.source || "valhalla";
      const logPrefix = `[Trace][User:${userId} / IP:${ip}]`;
      console.log(`${logPrefix} Received ${requestData.shape?.length || 0} points`);

      if (source === "browser") {
        const matchedPoints = Array.isArray(requestData.matched_points) ? requestData.matched_points : [];
        const rawPoints = Array.isArray(requestData.raw_points) ? requestData.raw_points : [];
        const matchedSamples = Array.isArray(requestData.matched_samples) ? requestData.matched_samples : [];
        const edges = Array.isArray(requestData.edges) ? requestData.edges : [];
        const validPoints = matchedPoints
          .map((point) => ({ lat: Number(point && point.lat), lon: Number(point && point.lon) }))
          .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
            point.lat >= -90 && point.lat <= 90 && point.lon >= -180 && point.lon <= 180);
        const validEdges = edges
          .map((edge) => ({ way_id: Number(edge && edge.way_id) }))
          .filter((edge) => Number.isSafeInteger(edge.way_id) && edge.way_id > 0);
        const validRawPoints = rawPoints.map((point) => ({
          lat: Number(point && point.lat), lon: Number(point && point.lon),
          accuracy: point && point.accuracy !== null ? Number(point.accuracy) : null,
        })).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
          point.lat >= -90 && point.lat <= 90 && point.lon >= -180 && point.lon <= 180 &&
          (point.accuracy === null || (Number.isFinite(point.accuracy) && point.accuracy >= 0)));
        const validMatchedSamples = matchedSamples.map((point) => ({
          lat: Number(point && point.lat), lon: Number(point && point.lon),
          way_id: Number(point && point.way_id), confidence: Number(point && point.confidence),
        })).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
          point.lat >= -90 && point.lat <= 90 && point.lon >= -180 && point.lon <= 180 &&
          Number.isSafeInteger(point.way_id) && point.way_id > 0 &&
          Number.isFinite(point.confidence) && point.confidence >= 0 && point.confidence <= 1);
        if (!sessionId || validPoints.length < 2 || validPoints.length > 5000 || validPoints.length !== matchedPoints.length ||
            validRawPoints.length < 2 || validRawPoints.length > 5000 || validRawPoints.length !== rawPoints.length ||
            validMatchedSamples.length > 5000 || validMatchedSamples.length !== matchedSamples.length) {
          sendJson(res, 400, { error: "invalid_browser_trace" });
          return;
        }
        if (!pool || !req.authUserId) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        try {
          const [ownedSessions] = await pool.query(
            "SELECT session_id FROM tactile.sessions WHERE session_id = ? AND user_id = ? LIMIT 1",
            [sessionId, req.authUserId]
          );
          if (!Array.isArray(ownedSessions) || !ownedSessions.length) {
            sendJson(res, 404, { error: "session_not_found_or_forbidden" });
            return;
          }
          if (canceledSessionIds && canceledSessionIds.has(sessionId)) {
            sendJson(res, 409, { error: "session_canceled" });
            return;
          }
          const browserData = { matched_points: validPoints, edges: validEdges };
          await persistSessionPath(pool, sessionId, "browser", browserData, logPrefix);
          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            await conn.query("DELETE FROM tactile.gps_raw WHERE session_id = ?", [sessionId]);
            await conn.query("DELETE FROM tactile.gps_matched WHERE session_id = ?", [sessionId]);
            for (const point of validRawPoints) {
              await conn.query(
                "INSERT INTO tactile.gps_raw (session_id, ts, geom, accuracy) VALUES (?, NOW(), ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)",
                [sessionId, point.lon, point.lat, point.accuracy]
              );
            }
            for (const point of validMatchedSamples) {
              await conn.query(
                "INSERT INTO tactile.gps_matched (session_id, ts, geom, edge_id, confidence) VALUES (?, NOW(), ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?, ?)",
                [sessionId, point.lon, point.lat, point.way_id, point.confidence]
              );
            }
            await conn.commit();
          } catch (pointSaveError) {
            await conn.rollback();
            throw pointSaveError;
          } finally {
            conn.release();
          }
          sendJson(res, 200, { ...browserData, source: "browser", persisted: true, osmSent: false });
        } catch (error) {
          console.error(`${logPrefix} browser_trace_save_error:`, error.message);
          sendJson(res, 500, { error: "browser_trace_save_failed" });
        }
        return;
      }

      const valhallaRequest = {
        shape: requestData.shape,
        costing: "pedestrian",
        shape_match: requestData.shape_match || "map_snap",
        trace_options: {
          // 呼び出し元の trace_options は残しつつ、歩道優先用の探索半径だけは明示上書きする。
          ...(requestData.trace_options && typeof requestData.trace_options === "object" ? requestData.trace_options : {}),
          search_radius: SIDEWALK_PRIORITY_RADIUS_METERS,
        },
        costing_options: {
          pedestrian: {
            ...PEDESTRIAN_SIDEWALK_COSTING_OPTIONS,
          },
        },
      };

      if (requestData.filters) {
        valhallaRequest.filters = requestData.filters;
      }

      const requestBody = JSON.stringify(valhallaRequest);
      const options = {
        hostname: VALHALLA_HOST,
        port: VALHALLA_PORT,
        path: "/trace_attributes",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody),
        },
      };

      // trace_attributes を直接呼び、応答をそのままクライアントへ返す。
      const valhallaReq = http.request(options, (apiRes) => {
        let responseBody = "";
        apiRes.on("data", (chunk) => {
          responseBody += chunk;
        });
        apiRes.on("end", () => {
          console.log(`${logPrefix} Valhalla response status: ${apiRes.statusCode}`);
          try {
            const data = JSON.parse(responseBody);
            console.log(`${logPrefix} Response: edges=${data.edges?.length || 0}, matched_points=${data.matched_points?.length || 0}`);

            if (sessionId && (!canceledSessionIds || !canceledSessionIds.has(sessionId))) {
              // 応答を先に返したいので、DB 保存は非同期で後追い実行する。
              persistSessionPath(pool, sessionId, source, data, logPrefix).catch((err) => {
                console.error(`${logPrefix} session_path_save_error:`, err.message);
              });
            } else if (sessionId) {
              // ユーザーがキャンセル済みなら、過去リクエストの保存だけ抑止する。
              console.log(`${logPrefix} session_path_save_skipped: canceled session=${sessionId}`);
            }

            sendJson(res, 200, data);
          } catch (err) {
            console.error(`${logPrefix} Parse error:`, err.message);
            sendJson(res, 500, { error: "valhalla_parse_error" });
          }
        });
      });

      valhallaReq.on("error", (err) => {
        console.error(`${logPrefix} Request error:`, err.message);
        sendJson(res, 500, { error: "valhalla_request_error", message: err.message });
      });

      valhallaReq.write(requestBody);
      valhallaReq.end();
    });
  };
}

module.exports = createTraceHandler;
