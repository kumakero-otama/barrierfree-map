const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const yaml = require("yaml");
const { Pool } = require("pg");

const batchId = process.argv[2];
if (!/^[0-9a-f-]{36}$/i.test(String(batchId || "")) || process.argv[3] !== "--production-read-only") {
  throw new Error("usage: node tools/prepare_fitting_outlier_maps.js <batch-id> --production-read-only");
}

function poolFrom(file) {
  const db = yaml.parse(fs.readFileSync(file, "utf8")).db;
  return new Pool({ host: db.host, port: db.port || 5432, user: db.user, password: db.password,
    database: db.database, max: 1, ssl: db.ssl ? { rejectUnauthorized: false } : undefined });
}

function getXml(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: "api.openstreetmap.org", path: pathname,
      headers: { "User-Agent": "StepBy-dev/1.0" } }, (res) => {
      let raw = ""; res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => res.statusCode === 200 ? resolve(raw) : reject(new Error(`osm_http_${res.statusCode}`)));
    });
    req.setTimeout(20000, () => req.destroy(new Error("osm_timeout"))); req.on("error", reject);
  });
}

async function wayCoordinates(wayId, cache) {
  if (cache.has(wayId)) return cache.get(wayId);
  const xml = await getXml(`/api/0.6/way/${wayId}/full`), nodes = new Map();
  for (const match of xml.matchAll(/<node\s+([^>]+)>/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([a-z_]+)="([^"]*)"/g)].map((item) => [item[1], item[2]]));
    nodes.set(Number(attrs.id), [Number(attrs.lat), Number(attrs.lon)]);
  }
  const way = new RegExp(`<way\\s+[^>]*id="${wayId}"[^>]*>([\\s\\S]*?)<\\/way>`).exec(xml);
  if (!way) throw new Error(`way_${wayId}_missing`);
  const coordinates = [...way[1].matchAll(/<nd ref="(\d+)"\/>/g)].map((item) => nodes.get(Number(item[1]))).filter(Boolean);
  cache.set(wayId, coordinates); return coordinates;
}

async function run() {
  const production = poolFrom("/home/otama/barrierfree-map/config.yaml");
  const development = poolFrom("/home/otama/barrierfree-map-dev/config.dev.yaml");
  const source = await production.connect(), target = await development.connect(), wayCache = new Map();
  try {
    const outliers = (await target.query(`SELECT source_session_digest,raw_point_count,
      (valhalla_result->>'meanDifferenceMeters')::float difference_m,
      (browser_result->>'connected')::boolean connected,browser_result->'wayIds' browser_way_ids,
      valhalla_result->'wayIds' valhalla_way_ids
      FROM experiment.production_fitting_batch_results WHERE batch_id=$1 AND status='compared'
        AND ((valhalla_result->>'meanDifferenceMeters')::float>10 OR NOT (browser_result->>'connected')::boolean)
      ORDER BY difference_m DESC`, [batchId])).rows;
    await source.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const sessions = (await source.query(`SELECT s.session_id,s.started_at,
      json_agg(json_build_array(ST_Y(r.geom::geometry),ST_X(r.geom::geometry)) ORDER BY r.ts,r.id) raw_points
      FROM tactile.sessions s JOIN tactile.gps_raw r USING(session_id) GROUP BY s.session_id,s.started_at`)).rows;
    await source.query("COMMIT");
    const byDigest = new Map(sessions.map((session) => [crypto.createHash("sha256").update(String(session.session_id)).digest("hex"), session]));
    await target.query(`CREATE TABLE IF NOT EXISTS experiment.fitting_outlier_maps(
      batch_id uuid NOT NULL,source_session_digest text NOT NULL,started_at timestamptz,raw_point_count integer NOT NULL,
      difference_m double precision NOT NULL,connected boolean NOT NULL,browser_way_ids jsonb NOT NULL,valhalla_way_ids jsonb NOT NULL,
      raw_points jsonb NOT NULL,browser_paths jsonb NOT NULL,valhalla_paths jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY(batch_id,source_session_digest))`);
    let saved = 0;
    for (const item of outliers) {
      const session = byDigest.get(item.source_session_digest); if (!session) continue;
      const browserPaths = [], valhallaPaths = [];
      for (const id of item.browser_way_ids || []) browserPaths.push({ wayId: id, coordinates: await wayCoordinates(Number(id), wayCache) });
      for (const id of item.valhalla_way_ids || []) valhallaPaths.push({ wayId: id, coordinates: await wayCoordinates(Number(id), wayCache) });
      await target.query(`INSERT INTO experiment.fitting_outlier_maps(batch_id,source_session_digest,started_at,raw_point_count,
        difference_m,connected,browser_way_ids,valhalla_way_ids,raw_points,browser_paths,valhalla_paths)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)
        ON CONFLICT(batch_id,source_session_digest) DO UPDATE SET browser_paths=EXCLUDED.browser_paths,
          valhalla_paths=EXCLUDED.valhalla_paths,raw_points=EXCLUDED.raw_points,created_at=NOW()`,
      [batchId,item.source_session_digest,session.started_at,item.raw_point_count,item.difference_m,item.connected,
        JSON.stringify(item.browser_way_ids),JSON.stringify(item.valhalla_way_ids),JSON.stringify(session.raw_points),
        JSON.stringify(browserPaths),JSON.stringify(valhallaPaths)]); saved += 1;
    }
    console.log(JSON.stringify({ batchId, outliers: outliers.length, saved, productionWritten: false, osmSent: false }));
  } finally { try { await source.query("ROLLBACK"); } catch {} source.release(); target.release(); await production.end(); await development.end(); }
}

run().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
