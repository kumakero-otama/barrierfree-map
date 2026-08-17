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
  const browserTrace = await request("/api/trace", {
    method: "POST",
    headers,
    body: JSON.stringify({
      sessionId: recordId,
      source: "browser",
      route_confirmed: true,
      raw_points: [
        { lat: 35.00003, lon: 139.0005, accuracy: 4.5 },
        { lat: 35.00003, lon: 139.0015, accuracy: 4.0 },
        { lat: 35.00003, lon: 139.0025, accuracy: 3.5 },
      ],
      matched_points: [
        { lat: 35, lon: 139.0005 },
        { lat: 35, lon: 139.0015 },
        { lat: 35, lon: 139.0025 },
      ],
      matched_samples: [
        { lat: 35, lon: 139.0005, way_id: 100, confidence: 0.8 },
        { lat: 35, lon: 139.0015, way_id: 100, confidence: 0.9 },
        { lat: 35, lon: 139.0025, way_id: 100, confidence: 0.85 },
      ],
      way_segments: [{
        way_id: 100,
        way_version: 7,
        node_ids: [10, 11, 12, 13],
        full_coordinates: [[139, 35], [139.001, 35], [139.002, 35], [139.003, 35]],
        segment_from: { kind: "projection", segmentIndex: 0, fraction: 0.5 },
        segment_to: { kind: "projection", segmentIndex: 2, fraction: 0.5 },
        original_tags: { highway: "footway", tactile_paving: "no" },
        relations: [],
        side: null,
        planned_tags: { tactile_paving: "yes" },
      }],
      edges: [{ way_id: 100 }],
    }),
  });
  assert.strictEqual(browserTrace.status, 200, JSON.stringify(browserTrace.body));
  assert.strictEqual(browserTrace.body.source, "browser");
  assert.strictEqual(browserTrace.body.persisted, true);
  assert.strictEqual(browserTrace.body.osmSent, false);
  const [browserPathRows] = await pool.query(
    "SELECT source FROM tactile.session_paths WHERE session_id = ? LIMIT 1",
    [recordId]
  );
  assert.strictEqual(browserPathRows[0].source, "browser");
  const [browserPointCounts] = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM tactile.gps_raw WHERE session_id = ?) raw_count,
       (SELECT COUNT(*)::int FROM tactile.gps_matched WHERE session_id = ?) matched_count`,
    [recordId, recordId]
  );
  assert.deepStrictEqual(browserPointCounts[0], { raw_count: 3, matched_count: 3 });
  const [snapshotRows] = await pool.query(
    `SELECT way_id,way_version,node_ids,full_coordinates,planned_tags
       FROM tactile.way_snapshots WHERE record_id=? ORDER BY segment_order`,
    [recordId]
  );
  assert.strictEqual(snapshotRows.length, 1);
  assert.strictEqual(Number(snapshotRows[0].way_id), 100);
  assert.strictEqual(snapshotRows[0].way_version, 7);
  assert.deepStrictEqual(snapshotRows[0].planned_tags, { tactile_paving: "yes" });
  const ended = await request("/api/session/end", {
    method: "POST", headers,
    body: JSON.stringify({ sessionId: recordId, endedAt: new Date().toISOString() }),
  });
  assert.strictEqual(ended.status, 200, JSON.stringify(ended.body));
  const [endedRows] = await pool.query("SELECT ended_at FROM tactile.sessions WHERE session_id=? LIMIT 1", [recordId]);
  assert.ok(endedRows[0].ended_at, "recording session must be finalized");
  const oauthStatus = await request("/auth/osm/status", { headers });
  assert.strictEqual(oauthStatus.status, 200, JSON.stringify(oauthStatus.body));
  assert.strictEqual(oauthStatus.body.configured, true);
  assert.strictEqual(oauthStatus.body.connected, false, "fresh guest must be treated as OSM-unconnected");
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
        tags: { highway: "footway", tactile_paving: "no" },
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

  const publishWithoutSaveAuthorization = await request(`/api/osm/records/${encodeURIComponent(recordId)}/publish`, {
    method: "POST", headers, body: JSON.stringify({}),
  });
  assert.strictEqual(publishWithoutSaveAuthorization.status, 409);
  assert.strictEqual(publishWithoutSaveAuthorization.body.error, "record_save_confirmation_required");
  const publishLocked = await request(`/api/osm/records/${encodeURIComponent(recordId)}/publish`, {
    method: "POST", headers, body: JSON.stringify({ authorization: "record_save" }),
  });
  assert.strictEqual(publishLocked.status, 423);
  assert.strictEqual(publishLocked.body.error, "osm_write_locked");
  assert.strictEqual(publishLocked.body.osmSent, false);

  const duplicate = await request("/api/osm/split-plan", {
    method: "POST", headers,
    body: JSON.stringify({ recordId, summary: "duplicate must fail", segments: [{
      wayId: 101, wayVersion: 1, nodes: [1, 2], fullCoordinates: [[139, 35], [139.001, 35]],
      tags: { highway: "footway", tactile_paving: "no" }, from: { kind: "node", index: 0 }, to: { kind: "node", index: 1 },
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

  const prematureRevert = await request(`/api/osm/records/${encodeURIComponent(recordId)}/revert-plan`, { method: "POST", headers });
  assert.strictEqual(prematureRevert.status, 409);
  assert.strictEqual(prematureRevert.body.error, "record_not_merged");

  const sourceElements = detail.body.plan.elements;
  const temporaryIds = {};
  let nextTemporaryId = -1;
  let nextCreatedId = 10000;
  const diffResult = sourceElements.map((element) => {
    if (element.action === "create") {
      temporaryIds[element.after.temporaryId] = nextTemporaryId;
      const result = { elementType: element.elementType, oldId: nextTemporaryId, newId: nextCreatedId, newVersion: 1 };
      nextTemporaryId -= 1;
      nextCreatedId += 1;
      return result;
    }
    return { elementType: element.elementType, oldId: element.osmId, newId: element.osmId, newVersion: element.version + 1 };
  });
  const fakeChangesetId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const fakeExecutionResult = { changesetId: fakeChangesetId, temporaryIds, diffResult };
  await pool.query(
    `INSERT INTO osmchange.audit_events(plan_id,event_type,actor_user_id,details)
     VALUES(?,?,?,?::jsonb) RETURNING event_id`,
    [created.body.planId, "execution_succeeded", guest.body.user.userId, JSON.stringify({ executionResult: fakeExecutionResult, syntheticTest: true })]
  );
  await pool.query(
    `UPDATE osmchange.record_links SET merge_changeset_id=?,osm_status='merged',updated_at=NOW()
     WHERE record_id=?`, [fakeChangesetId, recordId]
  );

  const revertWithoutDeleteAuthorization = await request(`/api/osm/records/${encodeURIComponent(recordId)}/revert`, {
    method: "POST", headers, body: JSON.stringify({}),
  });
  assert.strictEqual(revertWithoutDeleteAuthorization.status, 409);
  assert.strictEqual(revertWithoutDeleteAuthorization.body.error, "green_line_delete_confirmation_required");
  const revertLocked = await request(`/api/osm/records/${encodeURIComponent(recordId)}/revert`, {
    method: "POST", headers, body: JSON.stringify({ authorization: "owned_green_line_delete" }),
  });
  assert.strictEqual(revertLocked.status, 423);
  assert.strictEqual(revertLocked.body.error, "osm_write_locked");
  assert.strictEqual(revertLocked.body.osmSent, false);

  const reverted = await request(`/api/osm/records/${encodeURIComponent(recordId)}/revert-plan`, { method: "POST", headers });
  assert.strictEqual(reverted.status, 201);
  assert.strictEqual(reverted.body.osmSent, false);
  assert.strictEqual(reverted.body.executable, true);
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
