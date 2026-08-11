const fs = require("fs");
const path = require("path");

const sessionId = process.argv[2];
const sourceWayId = Number(process.argv[3]);
if (!sessionId || !Number.isSafeInteger(sourceWayId) || process.argv[4] !== "--confirm-development-osm-write") {
  throw new Error("usage: node tools/execute_development_osm_trial.js <dev-session-id> <source-way-id> --confirm-development-osm-write");
}
if (process.env.OSM_API_BASE_URL !== "https://master.apis.dev.openstreetmap.org") {
  throw new Error("development_osm_base_url_required");
}
if (process.env.OSM_WRITES_ENABLED !== "true") throw new Error("osm_write_flag_not_enabled");

const security = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config.security.dev.json"), "utf8"));
process.env.ACCESS_TOKEN_SECRET = security.accessTokenSecret;
const { createAccessToken } = require("../server/auth_token");
const { createDbPool } = require("../server/db");

async function request(pathname, { method = "GET", body, confirm } = {}) {
  const response = await fetch(`http://127.0.0.1:3100${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${createAccessToken(4, { expiresInSeconds: 300 })}`,
      "Content-Type": "application/json",
      "X-StepBy-Admin-Key": security.adminKey,
      ...(confirm ? { "X-StepBy-OSM-Confirm": confirm } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function run() {
  const { pool, error } = createDbPool();
  if (!pool) throw error || new Error("database_unavailable");
  const [rows] = await pool.query(`SELECT s.user_id,
      ST_AsGeoJSON(ST_SimplifyPreserveTopology(p.geom::geometry,0.00001)) geometry
    FROM tactile.sessions s JOIN tactile.session_paths p USING(session_id)
    WHERE s.session_id=? LIMIT 1`, [sessionId]);
  if (!rows[0] || String(rows[0].user_id) !== "4") throw new Error("development_record_not_found");
  const geometry = JSON.parse(rows[0].geometry);
  const coordinates = geometry.type === "LineString" ? geometry.coordinates : geometry.coordinates.flat();
  if (coordinates.length < 2 || coordinates.length > 450) throw new Error("invalid_trial_geometry");
  const nodeOperations = coordinates.map(([lng, lat], index) => ({
    elementType: "node", action: "create", after: { temporaryId: `trial-node-${index + 1}`, lat, lng, tags: {} },
  }));
  const wayOperation = {
    elementType: "way",
    action: "create",
    after: {
      temporaryId: "trial-way-1",
      nodes: coordinates.map((_, index) => `trial-node-${index + 1}`),
      tags: { highway: "footway", footway: "sidewalk", tactile_paving: "yes", source: "survey" },
    },
  };
  const summary = `StepBy development test: tactile paving record based on production Way ${sourceWayId}`;
  const plan = await request("/api/osm/plans", {
    method: "POST",
    body: {
      operationType: "merge",
      summary,
      elements: [...nodeOperations, wayOperation],
      clientContext: { environment: "development-osm", sessionId, sourceWayId, testOnly: true },
    },
  });
  const confirmation = `execute ${plan.planId}`;
  const execution = await request(`/api/osm/plans/${plan.planId}/execute`, {
    method: "POST", confirm: confirmation, body: { confirmation },
  });
  const createdWay = execution.executionResult.diffResult.find((item) => item.elementType === "way");
  console.log(JSON.stringify({ planId: plan.planId, changesetId: execution.executionResult.changesetId,
    developmentWayId: createdWay && createdWay.newId, nodeCount: coordinates.length, osmSent: true,
    target: "https://master.apis.dev.openstreetmap.org" }));
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
