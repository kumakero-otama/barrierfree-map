const assert = require("assert");
const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.TEST_API_URL || "http://127.0.0.1:3100";
const security = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.security.dev.json"), "utf8"));

async function request(apiPath, options = {}) {
  const response = await fetch(`${BASE_URL}${apiPath}`, options);
  return { status: response.status, body: await response.json() };
}

async function run() {
  const guest = await request("/auth/guest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      terms_accepted: true,
      privacy_accepted: true,
      terms_version: "2026-08-03",
      privacy_version: "2026-08-03",
    }),
  });
  assert.strictEqual(guest.status, 200, JSON.stringify(guest.body));
  const headers = {
    Authorization: `Bearer ${guest.body.access_token}`,
    "X-StepBy-Admin-Key": security.adminKey,
    "Content-Type": "application/json",
  };

  const unauthorized = await request("/api/admin/database-overview", {
    headers: { Authorization: headers.Authorization },
  });
  assert.strictEqual(unauthorized.status, 403);

  const overview = await request("/api/admin/database-overview", { headers });
  assert.strictEqual(overview.status, 200, JSON.stringify(overview.body));
  assert.strictEqual(overview.body.environment, "development");
  assert.ok(overview.body.tables.some((table) => table.key === "tactile.way_snapshots"));

  const payload = { test: true, coordinates: [139.001, 35.001], note: "development DB only" };
  const created = await request("/api/admin/experiments", {
    method: "POST", headers, body: JSON.stringify({ label: "AI API create/delete integration test", payload }),
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));

  const listed = await request("/api/admin/experiments", { headers });
  assert.strictEqual(listed.status, 200);
  assert.ok(listed.body.rows.some((row) => row.experiment_id === created.body.experimentId));

  const deleted = await request(`/api/admin/experiments/${created.body.experimentId}`, { method: "DELETE", headers });
  assert.strictEqual(deleted.status, 200, JSON.stringify(deleted.body));
  assert.strictEqual(deleted.body.payloadDigest, created.body.payloadDigest);

  const afterDelete = await request("/api/admin/experiments", { headers });
  assert.ok(!afterDelete.body.rows.some((row) => row.experiment_id === created.body.experimentId));

  const audit = await request("/api/admin/tables/experiment.api_record_audit?limit=20", { headers });
  assert.strictEqual(audit.status, 200, JSON.stringify(audit.body));
  const events = audit.body.rows.filter((row) => row.experiment_id === created.body.experimentId).map((row) => row.event_type);
  assert.deepStrictEqual(new Set(events), new Set(["created", "deleted"]));

  console.log(JSON.stringify({ result: "passed", experimentId: created.body.experimentId, deleted: true, productionDbUsed: false, osmSent: false }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
