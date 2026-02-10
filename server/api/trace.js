const http = require("http");
const { createDbPool } = require("../db");

function createLinestringWkt(points) {
  const coords = points
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => `${p.lon} ${p.lat}`);
  if (coords.length < 2) {
    return null;
  }
  return `SRID=4326;LINESTRING(${coords.join(",")})`;
}

async function persistSessionPath(pool, sessionId, source, data, logPrefix) {
  if (!pool || !sessionId) {
    return;
  }

  const matchedPoints = Array.isArray(data.matched_points) ? data.matched_points : [];
  const edges = Array.isArray(data.edges) ? data.edges : [];
  const wkt = createLinestringWkt(matchedPoints);
  if (!wkt) {
    console.warn(`${logPrefix} skip path save: not enough matched_points`);
    return;
  }

  const validEdges = edges
    .map((edge) => Number(edge && edge.way_id))
    .filter((edgeId) => Number.isFinite(edgeId));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      `INSERT INTO session_paths (session_id, geom, source)
       VALUES (?, ST_GeogFromText(?), ?)
       ON CONFLICT (session_id) DO UPDATE
         SET geom = EXCLUDED.geom,
             source = EXCLUDED.source,
             created_at = NOW()
       RETURNING session_id`,
      [sessionId, wkt, source]
    );

    await conn.query(
      "DELETE FROM session_path_edges WHERE session_id = ?",
      [sessionId]
    );

    for (let i = 0; i < validEdges.length; i += 1) {
      await conn.query(
        "INSERT INTO session_path_edges (session_id, seq, edge_id) VALUES (?, ?, ?) RETURNING session_id",
        [sessionId, i + 1, validEdges[i]]
      );
    }

    await conn.commit();
    console.log(`${logPrefix} saved session_paths + session_path_edges: edges=${validEdges.length}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function createTraceHandler({ sendJson }) {
  const VALHALLA_HOST = process.env.VALHALLA_HOST || "localhost";
  const VALHALLA_PORT = process.env.VALHALLA_PORT || "8002";
  const dbResult = createDbPool();
  const pool = dbResult.pool;

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
        costing: requestData.costing || "pedestrian",
        shape_match: requestData.shape_match || "map_snap",
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

            if (sessionId) {
              persistSessionPath(pool, sessionId, source, data, logPrefix).catch((err) => {
                console.error(`${logPrefix} session_path_save_error:`, err.message);
              });
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
