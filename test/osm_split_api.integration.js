const assert = require("assert");
const crypto = require("crypto");
const { createDbPool } = require("../server/db");

const BASE_URL = process.env.TEST_API_URL || "http://127.0.0.1:3100";

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, options);
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
  assert.strictEqual(guest.status, 200);
  const { pool, error } = createDbPool();
  if (error) throw error;
  const [consentRows] = await pool.query(
    `SELECT terms_version, privacy_version, acceptance_source
       FROM login.user_consents
      WHERE user_id = ?
      ORDER BY accepted_at DESC
      LIMIT 1`,
    [guest.body.user.userId]
  );
  assert.deepStrictEqual(consentRows[0], {
    terms_version: "2026-08-03",
    privacy_version: "2026-08-03",
    acceptance_source: "guest_signup",
  });
  const headers = {
    Authorization: `Bearer ${guest.body.access_token}`,
    "Content-Type": "application/json",
  };
  const recordId = crypto.randomUUID();
  const started = await request("/api/session/start", {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId: recordId, startedAt: new Date().toISOString() }),
  });
  assert.strictEqual(started.status, 200, JSON.stringify(started.body));
  const status = await request("/api/osm/status", { headers });
  assert.strictEqual(status.status, 200);
  assert.strictEqual(status.body.osmNetworkCodePresent, true);
  assert.strictEqual(status.body.osmWritesEnabled, false);
  const created = await request("/api/osm/split-plan", {
    method: "POST",
    headers,
    body: JSON.stringify({
      summary: "synthetic split integration test",
      recordId,
      segments: [{
        wayId: 100,
        wayVersion: 7,
        nodes: [10, 11, 12, 13],
        fullCoordinates: [[139, 35], [139.001, 35], [139.002, 35], [139.003, 35]],
        tags: { highway: "footway" },
        relations: [{
          id: 900,
          version: 3,
          tags: { type: "route", route: "foot" },
          members: [{ type: "way", ref: 100, role: "forward" }],
        }],
        from: { kind: "projection", segmentIndex: 0, fraction: 0.5 },
        to: { kind: "projection", segmentIndex: 2, fraction: 0.5 },
      }],
      clientContext: { test: true },
    }),
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  assert.strictEqual(created.body.osmSent, false);
  assert.deepStrictEqual(created.body.splitPlan.summary, {
    sourceWays: 1, createdNodes: 2, createdWays: 2, modifiedWays: 1, modifiedRelations: 1, operationCount: 6,
  });
  assert.strictEqual(created.body.recordId, recordId);

  const detail = await request(`/api/osm/plans/${created.body.planId}`, { headers });
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.body.plan.elements.length, 6);
  assert.strictEqual(detail.body.auditEvents[0].event_type, "split_plan_created");

  const linked = await request(`/api/osm/records/${encodeURIComponent(recordId)}`, { headers });
  assert.strictEqual(linked.status, 200);
  assert.strictEqual(linked.body.record.merge_plan_id, created.body.planId);
  assert.strictEqual(linked.body.record.osm_status, "draft");

  const duplicate = await request("/api/osm/split-plan", {
    method: "POST", headers,
    body: JSON.stringify({ recordId, summary: "duplicate must fail", segments: [{
      wayId: 101, wayVersion: 1, nodes: [1, 2], fullCoordinates: [[139, 35], [139.001, 35]],
      tags: { highway: "footway" }, from: { kind: "node", index: 0 }, to: { kind: "node", index: 1 },
    }] }),
  });
  assert.strictEqual(duplicate.status, 409);
  assert.strictEqual(duplicate.body.error, "record_already_linked");

  const fittingDetail = await request("/api/fitting-details/latest", { headers });
  assert.strictEqual(fittingDetail.status, 200);
  assert.strictEqual(fittingDetail.body.session.session_id, recordId);
  assert.strictEqual(fittingDetail.body.osm.status, "draft");
  assert.strictEqual(fittingDetail.body.osm.mergePlanId, created.body.planId);

  const blocked = await request(`/api/osm/plans/${created.body.planId}/execute`, { method: "POST", headers });
  assert.strictEqual(blocked.status, 423);
  assert.strictEqual(blocked.body.osmSent, false);

  const reverted = await request(`/api/osm/records/${encodeURIComponent(recordId)}/revert-plan`, { method: "POST", headers });
  assert.strictEqual(reverted.status, 201);
  assert.strictEqual(reverted.body.osmSent, false);
  assert.strictEqual(reverted.body.executable, false);
  assert.strictEqual(reverted.body.recordId, recordId);
  const linkedAfterRevert = await request(`/api/osm/records/${encodeURIComponent(recordId)}`, { headers });
  assert.strictEqual(linkedAfterRevert.body.record.osm_status, "revert_draft");
  assert.strictEqual(linkedAfterRevert.body.record.revert_plan_id, reverted.body.planId);
  const duplicateRevert = await request(`/api/osm/records/${encodeURIComponent(recordId)}/revert-plan`, { method: "POST", headers });
  assert.strictEqual(duplicateRevert.status, 409);
  assert.strictEqual(duplicateRevert.body.error, "revert_plan_already_exists");
  const blockedRevert = await request(`/api/osm/plans/${reverted.body.planId}/execute-revert`, { method: "POST", headers });
  assert.strictEqual(blockedRevert.status, 423);
  assert.strictEqual(blockedRevert.body.osmSent, false);

  console.log(JSON.stringify({
    result: "passed",
    splitPlanId: created.body.planId,
    revertPlanId: reverted.body.planId,
    osmSent: false,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
