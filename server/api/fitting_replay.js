const http = require("http");
const crypto = require("crypto");
const { createDbPool } = require("../db");
const { fetchWalkableNetwork } = require("./osm_walkable");
const { replay, distanceMeters } = require("../fitting/browser_matcher");

const MAX_BODY_BYTES = 32 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (Buffer.byteLength(body) > MAX_BODY_BYTES) reject(new Error("payload_too_large")); });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("invalid_json")); } });
    req.on("error", reject);
  });
}

function requestValhalla(points) {
  const payload = JSON.stringify({ shape: points.map((p) => ({ lat: p.lat, lon: p.lng })), costing: "pedestrian", shape_match: "map_snap",
    trace_options: { search_radius: 10 },
    costing_options: { pedestrian: { walkway_factor: 0.1, sidewalk_factor: 0.1 } } });
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const request = http.request({ hostname: process.env.VALHALLA_HOST || "localhost", port: process.env.VALHALLA_PORT || 8002,
      path: "/trace_attributes", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (response) => {
      let raw = "";
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          let detail = "";
          try { detail = JSON.parse(raw).error || JSON.parse(raw).error_code || ""; } catch {}
          return reject(new Error(`valhalla_status_${response.statusCode}${detail ? `:${detail}` : ""}`));
        }
        try { resolve({ data: JSON.parse(raw), durationMs: Date.now() - startedAt }); } catch { reject(new Error("valhalla_invalid_json")); }
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error("valhalla_timeout")));
    request.on("error", reject); request.write(payload); request.end();
  });
}

async function fetchNetworkWithFallback(lat, lng) {
  const hosts = [...new Set([process.env.OVERPASS_HOST, "overpass-api.de", "overpass.kumi.systems", "overpass.nchc.org.tw"].filter(Boolean))];
  let lastError;
  for (const host of hosts) {
    try { return await fetchWalkableNetwork(lat, lng, 1000, host); }
    catch (error) { lastError = error; }
  }
  throw lastError || new Error("overpass_unavailable");
}

function valhallaSummary(result, browserMatches) {
  const points = (result.data.matched_points || []).map((point) => ({ lat: Number(point.lat), lng: Number(point.lon) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  const wayIds = (result.data.edges || []).map((edge) => Number(edge.way_id || edge.edge_info?.way_id)).filter(Number.isSafeInteger);
  const distances = points.slice(0, browserMatches.length).map((point, index) => browserMatches[index]
    ? distanceMeters(point, { lat: browserMatches[index].lat, lng: browserMatches[index].lng }) : null).filter(Number.isFinite);
  return { durationMs: result.durationMs, matchedPointCount: points.length, wayIds: [...new Set(wayIds)],
    meanDifferenceMeters: distances.length ? distances.reduce((sum, value) => sum + value, 0) / distances.length : null,
    maxDifferenceMeters: distances.length ? Math.max(...distances) : null };
}

function jaccard(left, right) {
  const a = new Set(left), b = new Set(right), union = new Set([...a, ...b]);
  return union.size ? [...a].filter((value) => b.has(value)).length / union.size : null;
}

function grade(browser, valhalla) {
  const checks = {
    browserCoverage: browser.coverage >= 0.8,
    connectedRoute: browser.connected,
    pedestrianPriority: browser.missedPedestrianPriority === 0,
    browserSpeed: browser.durationMs <= 5000,
    valhallaAvailable: Boolean(valhalla),
  };
  const required = [checks.browserCoverage, checks.connectedRoute, checks.pedestrianPriority, checks.browserSpeed];
  return { status: required.every(Boolean) && checks.valhallaAvailable ? "pass" : browser.coverage >= 0.5 ? "warning" : "fail", checks };
}

function createFittingReplayHandler({ sendJson }) {
  const { pool, error } = createDbPool();
  let ready;
  async function ensureSchema() {
    if (!ready) ready = pool.query(`CREATE TABLE IF NOT EXISTS experiment.fitting_replay_runs (
      run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid NOT NULL,requested_by text NOT NULL,
      raw_point_count integer NOT NULL,network_way_count integer NOT NULL,browser_result jsonb NOT NULL,
      valhalla_result jsonb,score jsonb NOT NULL,status text NOT NULL,osm_sent boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT NOW())`).catch((schemaError) => { ready = null; throw schemaError; });
    return ready;
  }
  return async function handle(req, res) {
    if (process.env.NODE_ENV !== "development") return sendJson(res, 404, { error: "not_found" });
    if (!pool) return sendJson(res, 503, { error: "database_unavailable", message: error && error.message });
    try {
      await ensureSchema();
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET") {
        const [rows] = await pool.query(`SELECT run_id,session_id,raw_point_count,network_way_count,browser_result,
          valhalla_result,score,status,osm_sent,created_at FROM experiment.fitting_replay_runs ORDER BY created_at DESC LIMIT 50`);
        return sendJson(res, 200, { success: true, runs: rows });
      }
      if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
      const body = await readJson(req);
      let sessionId = body.sessionId ? String(body.sessionId) : null;
      if (!sessionId) {
        const [sessions] = await pool.query(`SELECT s.session_id FROM tactile.sessions s
          WHERE EXISTS(SELECT 1 FROM tactile.gps_raw r WHERE r.session_id=s.session_id)
            AND (SELECT COUNT(*) FROM tactile.gps_raw r WHERE r.session_id=s.session_id) >= 5
          ORDER BY s.started_at DESC LIMIT 1`);
        sessionId = sessions[0] && String(sessions[0].session_id);
      }
      if (!sessionId) return sendJson(res, 404, { error: "recording_not_found" });
      const [rawRows] = await pool.query(`SELECT ST_Y(geom::geometry) lat,ST_X(geom::geometry) lng,accuracy
        FROM tactile.gps_raw WHERE session_id::text=? ORDER BY ts,id`, [sessionId]);
      const points = rawRows.map((row) => ({ lat: Number(row.lat), lng: Number(row.lng), accuracy: row.accuracy == null ? null : Number(row.accuracy) }));
      if (points.length < 2) return sendJson(res, 422, { error: "not_enough_gps_points" });
      const center = points.reduce((value, point) => ({ lat: value.lat + point.lat / points.length, lng: value.lng + point.lng / points.length }), { lat: 0, lng: 0 });
      const network = await fetchNetworkWithFallback(center.lat, center.lng);
      const browser = replay(points, network.ways);
      let valhalla = null, valhallaError = null;
      try { valhalla = valhallaSummary(await requestValhalla(points), browser.matches); } catch (requestError) { valhallaError = requestError.message; }
      if (valhalla) valhalla.wayJaccard = jaccard(browser.wayIds, valhalla.wayIds);
      const score = grade(browser, valhalla);
      const browserResult = { ...browser, matches: browser.matches.map((match) => match && ({ lat: match.lat, lng: match.lng, wayId: match.wayId,
        wayVersion: match.wayVersion, distance: match.distance, priority: match.priority, connectedToPrevious: match.connectedToPrevious })) };
      const valhallaResult = valhalla ? valhalla : { error: valhallaError };
      const runId = crypto.randomUUID();
      await pool.query(`INSERT INTO experiment.fitting_replay_runs(
        run_id,session_id,requested_by,raw_point_count,network_way_count,browser_result,valhalla_result,score,status,osm_sent)
        VALUES(?,?,?, ?,?,?::jsonb,?::jsonb,?::jsonb,?,false) RETURNING run_id`,
      [runId, sessionId, req.authUserId, points.length, network.wayCount, JSON.stringify(browserResult), JSON.stringify(valhallaResult), JSON.stringify(score), score.status]);
      return sendJson(res, 201, { success: true, runId, createdAt: new Date().toISOString(), sessionId,
        rawPointCount: points.length, networkWayCount: network.wayCount, browser: browserResult, valhalla: valhallaResult, score, osmSent: false });
    } catch (requestError) {
      console.error("[fitting_replay] failed", requestError.message);
      return sendJson(res, 500, { error: "fitting_replay_failed", message: requestError.message });
    }
  };
}

module.exports = createFittingReplayHandler;
