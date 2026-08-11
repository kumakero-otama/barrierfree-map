const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const yaml = require("yaml");
const { Pool } = require("pg");
const { fetchWalkableNetwork } = require("../server/api/osm_walkable");
const { replay, distanceMeters } = require("../server/fitting/browser_matcher");

const retryBatchId = process.argv[2] === "--retry-batch" ? process.argv[3] : null;
if (process.argv[2] !== "--production-read-only" && !/^[0-9a-f-]{36}$/i.test(String(retryBatchId || ""))) {
  throw new Error("explicit_read_only_flag_required");
}

function poolFrom(file) {
  const db = yaml.parse(fs.readFileSync(file, "utf8")).db;
  return new Pool({ host: db.host, port: db.port || 5432, user: db.user, password: db.password,
    database: db.database, max: 2, ssl: db.ssl ? { rejectUnauthorized: false } : undefined });
}

function valhallaRequest(points, radius) {
  const payload = JSON.stringify({ shape: points.map((point) => ({ lat: point.lat, lon: point.lng })),
    costing: "pedestrian", shape_match: "map_snap", trace_options: { search_radius: radius },
    costing_options: { pedestrian: { walkway_factor: 0.1, sidewalk_factor: 0.1 } } });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const req = http.request({ hostname: process.env.VALHALLA_HOST || "127.0.0.1",
      port: Number(process.env.VALHALLA_PORT || 8002), path: "/trace_attributes", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`valhalla_status_${res.statusCode}`));
        try { resolve({ data: JSON.parse(raw), durationMs: Date.now() - started, radius }); }
        catch { reject(new Error("valhalla_invalid_json")); }
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error("valhalla_timeout")));
    req.on("error", reject); req.write(payload); req.end();
  });
}

async function valhalla(points) {
  try { return await valhallaRequest(points, 10); }
  catch (error) { const result = await valhallaRequest(points, 50); return { ...result, fallback: true, primaryError: error.message }; }
}

function summarizeValhalla(result, browserMatches) {
  const points = (result.data.matched_points || []).map((point) => ({ lat: Number(point.lat), lng: Number(point.lon) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  const wayIds = [...new Set((result.data.edges || []).map((edge) => Number(edge.way_id || edge.edge_info?.way_id)).filter(Number.isSafeInteger))];
  const distances = points.slice(0, browserMatches.length).map((point, index) => browserMatches[index]
    ? distanceMeters(point, browserMatches[index]) : null).filter(Number.isFinite);
  return { durationMs: result.durationMs, searchRadius: result.radius, fallback: Boolean(result.fallback),
    matchedPointCount: points.length, wayIds, meanDifferenceMeters: distances.length ? distances.reduce((a, b) => a + b, 0) / distances.length : null,
    maxDifferenceMeters: distances.length ? Math.max(...distances) : null };
}

function jaccard(left, right) {
  const a = new Set(left), b = new Set(right), union = new Set([...a, ...b]);
  return union.size ? [...a].filter((value) => b.has(value)).length / union.size : null;
}

async function fetchNetwork(center, cache) {
  const key = `${center.lat.toFixed(3)}:${center.lng.toFixed(3)}`;
  if (cache.has(key)) return cache.get(key);
  const pending = (async () => {
    const hosts = retryBatchId
      ? ["overpass.kumi.systems", "overpass.private.coffee", "overpass-api.de"]
      : ["overpass-api.de", "overpass.kumi.systems"];
    let lastError;
    for (const host of hosts) {
      try { return await fetchWalkableNetwork(center.lat, center.lng, 1000, host); }
      catch (error) { lastError = error; }
    }
    throw lastError || new Error("overpass_unavailable");
  })();
  cache.set(key, pending);
  return pending;
}

async function mapLimit(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor; cursor += 1; await worker(items[index], index); }
  });
  await Promise.all(runners);
}

async function run() {
  const production = poolFrom(process.env.PRODUCTION_DB_CONFIG_PATH || "/home/otama/barrierfree-map/config.yaml");
  const development = poolFrom(process.env.DEVELOPMENT_DB_CONFIG_PATH || "/home/otama/barrierfree-map-dev/config.dev.yaml");
  const source = await production.connect(), target = await development.connect();
  const batchId = retryBatchId || crypto.randomUUID(), networkCache = new Map();
  try {
    await source.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const sessions = (await source.query(`SELECT s.session_id,s.started_at,
      COALESCE(json_agg(json_build_object('lat',ST_Y(r.geom::geometry),'lng',ST_X(r.geom::geometry),'accuracy',r.accuracy)
        ORDER BY r.ts,r.id) FILTER(WHERE r.id IS NOT NULL),'[]') points
      FROM tactile.sessions s LEFT JOIN tactile.gps_raw r USING(session_id)
      GROUP BY s.session_id,s.started_at ORDER BY s.started_at`)).rows;
    await source.query("COMMIT");
    await target.query(`CREATE TABLE IF NOT EXISTS experiment.production_fitting_batches(
      batch_id uuid PRIMARY KEY,total_records integer NOT NULL,eligible_records integer NOT NULL,status text NOT NULL,
      summary jsonb NOT NULL DEFAULT '{}'::jsonb,started_at timestamptz NOT NULL DEFAULT NOW(),completed_at timestamptz)`);
    await target.query(`CREATE TABLE IF NOT EXISTS experiment.production_fitting_batch_results(
      batch_id uuid NOT NULL,source_session_digest text NOT NULL,started_at timestamptz,raw_point_count integer NOT NULL,
      status text NOT NULL,browser_result jsonb,valhalla_result jsonb,error text,created_at timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY(batch_id,source_session_digest))`);
    const eligible = sessions.filter((session) => session.points.length >= 2);
    let workSessions = sessions;
    if (retryBatchId) {
      const failures = (await target.query(`SELECT source_session_digest FROM experiment.production_fitting_batch_results
        WHERE batch_id=$1 AND status='browser_error'`, [batchId])).rows.map((row) => row.source_session_digest);
      const failureSet = new Set(failures);
      workSessions = sessions.filter((session) => failureSet.has(crypto.createHash("sha256").update(String(session.session_id)).digest("hex")));
      await target.query(`UPDATE experiment.production_fitting_batches SET status='retrying',completed_at=NULL WHERE batch_id=$1`, [batchId]);
    } else {
      await target.query(`INSERT INTO experiment.production_fitting_batches(batch_id,total_records,eligible_records,status)
        VALUES($1,$2,$3,'running')`, [batchId, sessions.length, eligible.length]);
    }
    let completed = 0;
    await mapLimit(workSessions, retryBatchId ? 2 : 4, async (session) => {
      const digest = crypto.createHash("sha256").update(String(session.session_id)).digest("hex");
      if (session.points.length < 2) {
        await target.query(`INSERT INTO experiment.production_fitting_batch_results
          (batch_id,source_session_digest,started_at,raw_point_count,status,error) VALUES($1,$2,$3,$4,'ineligible','fewer_than_2_raw_points')`,
          [batchId, digest, session.started_at, session.points.length]);
        return;
      }
      const points = session.points.map((point) => ({ lat: Number(point.lat), lng: Number(point.lng),
        accuracy: point.accuracy == null ? null : Number(point.accuracy) }));
      let browserResult = null, valhallaResult = null, status = "compared", error = null;
      try {
        const center = points.reduce((sum, point) => ({ lat: sum.lat + point.lat / points.length,
          lng: sum.lng + point.lng / points.length }), { lat: 0, lng: 0 });
        const network = await fetchNetwork(center, networkCache);
        const browser = replay(points, network.ways);
        browserResult = { coverage: browser.coverage, connected: browser.connected, durationMs: browser.durationMs,
          wayIds: browser.wayIds, pedestrianMatches: browser.pedestrianMatches, interpolatedPointCount: browser.interpolatedPointCount,
          discardedPointCount: browser.discardedPointCount, missedPedestrianPriority: browser.missedPedestrianPriority,
          meanSnapDistance: browser.meanSnapDistance, maxSnapDistance: browser.maxSnapDistance, networkWayCount: network.wayCount };
        try {
          valhallaResult = summarizeValhalla(await valhalla(points), browser.matches);
          valhallaResult.wayJaccard = jaccard(browser.wayIds, valhallaResult.wayIds);
        } catch (valhallaError) { status = "valhalla_error"; error = valhallaError.message; }
      } catch (browserError) { status = "browser_error"; error = browserError.message; }
      await target.query(`INSERT INTO experiment.production_fitting_batch_results
        (batch_id,source_session_digest,started_at,raw_point_count,status,browser_result,valhalla_result,error)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
        ON CONFLICT(batch_id,source_session_digest) DO UPDATE SET status=EXCLUDED.status,browser_result=EXCLUDED.browser_result,
          valhalla_result=EXCLUDED.valhalla_result,error=EXCLUDED.error,created_at=NOW()`, [batchId, digest, session.started_at, points.length, status,
        browserResult ? JSON.stringify(browserResult) : null, valhallaResult ? JSON.stringify(valhallaResult) : null, error]);
      completed += 1;
      if (completed % 20 === 0) console.log(JSON.stringify({ batchId, completed, workRecords: workSessions.length, networkAreas: networkCache.size }));
    });
    const results = (await target.query(`SELECT status,raw_point_count,browser_result,valhalla_result
      FROM experiment.production_fitting_batch_results WHERE batch_id=$1`, [batchId])).rows;
    const compared = results.filter((row) => row.status === "compared"), browserRows = results.filter((row) => row.browser_result);
    const avg = (rows, getter) => { const values = rows.map(getter).map(Number).filter(Number.isFinite); return values.length ? values.reduce((a,b)=>a+b,0)/values.length : null; };
    const summary = { totalRecords: sessions.length, eligibleRecords: eligible.length, comparedRecords: compared.length,
      ineligibleRecords: results.filter((row) => row.status === "ineligible").length,
      browserErrorRecords: results.filter((row) => row.status === "browser_error").length,
      valhallaErrorRecords: results.filter((row) => row.status === "valhalla_error").length,
      totalRawPoints: results.reduce((sum,row)=>sum+Number(row.raw_point_count),0), networkAreas: networkCache.size,
      meanBrowserCoverage: avg(browserRows, row => row.browser_result.coverage),
      connectedBrowserRate: browserRows.length ? browserRows.filter(row=>row.browser_result.connected).length/browserRows.length : null,
      meanBrowserSnapMeters: avg(browserRows, row => row.browser_result.meanSnapDistance),
      meanBrowserDiscardedPoints: avg(browserRows, row => row.browser_result.discardedPointCount),
      meanDifferenceMeters: avg(compared, row => row.valhalla_result.meanDifferenceMeters),
      meanMaxDifferenceMeters: avg(compared, row => row.valhalla_result.maxDifferenceMeters),
      meanWayJaccard: avg(compared, row => row.valhalla_result.wayJaccard),
      valhallaFallbackRecords: compared.filter(row=>row.valhalla_result.fallback).length,
      productionWritten: false, osmSent: false };
    await target.query(`UPDATE experiment.production_fitting_batches SET status='complete',summary=$2::jsonb,completed_at=NOW() WHERE batch_id=$1`,
      [batchId, JSON.stringify(summary)]);
    console.log(JSON.stringify({ batchId, summary }));
  } catch (error) {
    try { await source.query("ROLLBACK"); } catch {}
    try { await target.query(`UPDATE experiment.production_fitting_batches SET status='failed',summary=$2::jsonb,completed_at=NOW() WHERE batch_id=$1`,
      [batchId, JSON.stringify({ error: error.message, productionWritten: false, osmSent: false })]); } catch {}
    throw error;
  } finally { source.release(); target.release(); await production.end(); await development.end(); }
}

run().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
