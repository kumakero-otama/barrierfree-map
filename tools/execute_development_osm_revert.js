const fs = require("fs");
const path = require("path");

const sourcePlanId = process.argv[2];
if (!/^[0-9a-f-]{36}$/i.test(String(sourcePlanId || "")) || process.argv[3] !== "--confirm-development-osm-revert") {
  throw new Error("usage: node tools/execute_development_osm_revert.js <source-plan-id> --confirm-development-osm-revert");
}
if (process.env.OSM_API_BASE_URL !== "https://master.apis.dev.openstreetmap.org") {
  throw new Error("development_osm_base_url_required");
}
if (process.env.OSM_WRITES_ENABLED !== "true") throw new Error("osm_write_flag_not_enabled");

const security = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config.security.dev.json"), "utf8"));
process.env.ACCESS_TOKEN_SECRET = security.accessTokenSecret;
const { createAccessToken } = require("../server/auth_token");

async function request(pathname, { body, confirm } = {}) {
  const response = await fetch(`http://127.0.0.1:3100${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${createAccessToken(4, { expiresInSeconds: 300 })}`,
      "Content-Type": "application/json",
      "X-StepBy-Admin-Key": security.adminKey,
      ...(confirm ? { "X-StepBy-OSM-Confirm": confirm } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

async function run() {
  const proposal = await request(`/api/osm/plans/${sourcePlanId}/revert-plan`);
  if (!proposal.executable) throw new Error("generated_revert_is_not_executable");
  const confirmation = `execute-revert ${proposal.planId}`;
  const execution = await request(`/api/osm/plans/${proposal.planId}/execute-revert`, {
    confirm: confirmation,
    body: { confirmation },
  });
  console.log(JSON.stringify({ sourcePlanId, revertPlanId: proposal.planId,
    changesetId: execution.executionResult.changesetId,
    deletedElements: execution.executionResult.diffResult.length,
    osmSent: true, target: "https://master.apis.dev.openstreetmap.org" }));
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
