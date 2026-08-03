const assert = require("assert");

const BASE_URL = process.env.TEST_API_URL || "http://127.0.0.1:3100";

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  return { status: response.status, body: await response.json() };
}

async function run() {
  const guest = await request("/auth/guest", { method: "POST" });
  assert.strictEqual(guest.status, 200);
  const headers = {
    Authorization: `Bearer ${guest.body.access_token}`,
    "Content-Type": "application/json",
  };
  const created = await request("/api/osm/split-plan", {
    method: "POST",
    headers,
    body: JSON.stringify({
      summary: "synthetic split integration test",
      segments: [{
        wayId: 100,
        wayVersion: 7,
        nodes: [10, 11, 12, 13],
        fullCoordinates: [[139, 35], [139.001, 35], [139.002, 35], [139.003, 35]],
        tags: { highway: "footway" },
        from: { kind: "projection", segmentIndex: 0, fraction: 0.5 },
        to: { kind: "projection", segmentIndex: 2, fraction: 0.5 },
      }],
      clientContext: { test: true },
    }),
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  assert.strictEqual(created.body.osmSent, false);
  assert.deepStrictEqual(created.body.splitPlan.summary, {
    sourceWays: 1, createdNodes: 2, createdWays: 2, modifiedWays: 1, operationCount: 5,
  });

  const detail = await request(`/api/osm/plans/${created.body.planId}`, { headers });
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.body.plan.elements.length, 5);
  assert.strictEqual(detail.body.auditEvents[0].event_type, "split_plan_created");

  const blocked = await request(`/api/osm/plans/${created.body.planId}/execute`, { method: "POST", headers });
  assert.strictEqual(blocked.status, 423);
  assert.strictEqual(blocked.body.osmSent, false);

  const reverted = await request(`/api/osm/plans/${created.body.planId}/revert-plan`, { method: "POST", headers });
  assert.strictEqual(reverted.status, 201);
  assert.strictEqual(reverted.body.osmSent, false);

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
