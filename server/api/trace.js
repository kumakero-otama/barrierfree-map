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

// trace結果をセッション単位の経路テーブルへ反映する。
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

    // 紐づくエッジ列は一旦削除して再作成する。
    await conn.query(
      "DELETE FROM tactile.session_path_edges WHERE session_id = ?",
      [sessionId]
    );

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

    req.on("end", () => {
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

      const valhallaRequest = {
        shape: requestData.shape,
        costing: "pedestrian",
        shape_match: requestData.shape_match || "map_snap",
        trace_options: {
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
              persistSessionPath(pool, sessionId, source, data, logPrefix).catch((err) => {
                console.error(`${logPrefix} session_path_save_error:`, err.message);
              });
            } else if (sessionId) {
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
