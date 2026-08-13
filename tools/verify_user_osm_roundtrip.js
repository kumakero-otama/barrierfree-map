const crypto = require("crypto");
const { createDbPool } = require("../server/db");
const { createAccessToken } = require("../server/auth_token");
const { createUserOsmClient } = require("../server/osm/user_oauth_client");
const { executeWithClient } = require("../server/osm/osm_executor");

if (process.argv[2] !== "--confirm-development-osm-roundtrip") {
  throw new Error("development_osm_roundtrip_confirmation_required");
}
if (process.env.OSM_API_BASE_URL !== "https://master.apis.dev.openstreetmap.org") {
  throw new Error("development_osm_base_url_required");
}
if (process.env.OSM_WRITES_ENABLED !== "true") throw new Error("osm_write_flag_not_enabled");

const API_ROOT = "http://127.0.0.1:3100";

async function apiRequest(token, pathname, body) {
  const response = await fetch(`${API_ROOT}${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${pathname}: HTTP ${response.status} ${payload.error || "unknown"}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function fetchWay(osmId) {
  const response = await fetch(`${process.env.OSM_API_BASE_URL}/api/0.6/way/${osmId}`);
  const xml = await response.text();
  if (!response.ok) throw new Error(`way_fetch_failed:${response.status}`);
  const version = Number(/<way\s+[^>]*version="(\d+)"/.exec(xml)?.[1]);
  const tags = Object.fromEntries([...xml.matchAll(/<tag k="([^"]+)" v="([^"]*)"/g)].map((match) => [match[1], match[2]]));
  return { version, tags };
}

async function run() {
  const { pool, error } = createDbPool();
  if (!pool) throw error || new Error("database_unavailable");
  const [connections] = await pool.query(
    `SELECT user_id FROM login.osm_connections WHERE status='connected' ORDER BY connected_at LIMIT 1`
  );
  const userId = Number(connections[0] && connections[0].user_id);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("connected_development_user_required");
  const client = await createUserOsmClient(pool, userId);
  const token = createAccessToken(userId, { expiresInSeconds: 600 });
  const sessionId = crypto.randomUUID();
  const fixturePlanId = crypto.randomUUID();
  const cleanupPlanId = crypto.randomUUID();
  // OSM開発環境内の既存データと重ならない海上の小さな試験形状。
  const coordinates = [[135.00000, 20.00000], [135.00008, 20.00000], [135.00016, 20.00000]];
  let fixture = null;
  let publication = null;
  let revert = null;
  try {
    fixture = await executeWithClient({
      client,
      planId: fixturePlanId,
      operationType: "development_fixture",
      summary: "StepBy development fixture for save and revert integration test",
      operations: [
        ...coordinates.map(([lng, lat], index) => ({
          elementType: "node", action: "create", osmId: null, version: null, before: null,
          after: { temporaryId: `fixture-node-${index + 1}`, lat, lng, tags: {} },
        })),
        {
          elementType: "way", action: "create", osmId: null, version: null, before: null,
          after: {
            temporaryId: "fixture-way-1",
            nodes: coordinates.map((_, index) => `fixture-node-${index + 1}`),
            tags: { highway: "footway", source: "StepBy development test" },
          },
        },
      ],
    });
    const wayResult = fixture.diffResult.find((item) => item.elementType === "way");
    const nodeResults = fixture.diffResult.filter((item) => item.elementType === "node");
    const wayId = Number(wayResult && wayResult.newId);
    const nodeIds = nodeResults.map((item) => Number(item.newId));
    if (!Number.isSafeInteger(wayId) || nodeIds.length !== coordinates.length) throw new Error("fixture_creation_failed");

    await apiRequest(token, "/api/session/start", { sessionId, startedAt: new Date().toISOString() });
    await apiRequest(token, "/api/session-tags", { sessionId, tagCode: "tactile_paving" });
    await apiRequest(token, "/api/session/end", { sessionId, endedAt: new Date().toISOString() });
    const splitPlan = await apiRequest(token, "/api/osm/split-plan", {
      recordId: sessionId,
      summary: "StepBy development UI save roundtrip test",
      segments: [{
        wayId, wayVersion: Number(wayResult.newVersion), nodes: nodeIds,
        fullCoordinates: coordinates,
        tags: { highway: "footway", source: "StepBy development test" },
        relations: [], side: null,
        from: { kind: "node", index: 0 }, to: { kind: "node", index: 2 },
      }],
      clientContext: { ui: "UI10", testOnly: true, authorization: "record_save" },
    });
    publication = await apiRequest(token, `/api/osm/records/${sessionId}/publish`, { authorization: "record_save" });
    const publishedWay = await fetchWay(wayId);
    if (publishedWay.tags.tactile_paving !== "yes") throw new Error("tactile_tag_not_published");
    const duplicatePublication = await apiRequest(token, `/api/osm/records/${sessionId}/publish`, { authorization: "record_save" });
    if (!duplicatePublication.idempotent || Number(duplicatePublication.changesetId) !== Number(publication.executionResult.changesetId)) {
      throw new Error("publication_idempotency_failed");
    }

    revert = await apiRequest(token, `/api/osm/records/${sessionId}/revert`, { authorization: "owned_green_line_delete" });
    const revertedWay = await fetchWay(wayId);
    if (Object.prototype.hasOwnProperty.call(revertedWay.tags, "tactile_paving")) throw new Error("tactile_tag_not_reverted");
    const duplicateRevert = await apiRequest(token, `/api/osm/records/${sessionId}/revert`, { authorization: "owned_green_line_delete" });
    if (!duplicateRevert.idempotent || Number(duplicateRevert.changesetId) !== Number(revert.executionResult.changesetId)) {
      throw new Error("revert_idempotency_failed");
    }
    const [auditRows] = await pool.query(
      `SELECT event_type FROM osmchange.audit_events WHERE plan_id IN (?,?) ORDER BY event_id`,
      [splitPlan.planId, revert.planId]
    );
    const auditEvents = auditRows.map((row) => row.event_type);
    for (const required of ["split_plan_created", "user_execution_requested", "execution_authorized", "changeset_created", "execution_succeeded", "revert_plan_created"]) {
      if (!auditEvents.includes(required)) throw new Error(`missing_audit_event:${required}`);
    }

    const currentVersion = revertedWay.version;
    await executeWithClient({
      client,
      planId: cleanupPlanId,
      operationType: "development_fixture_cleanup",
      summary: "Remove StepBy development roundtrip fixture",
      operations: [
        {
          elementType: "way", action: "delete", osmId: wayId, version: currentVersion,
          before: { nodes: nodeIds, tags: revertedWay.tags }, after: null,
        },
        ...nodeIds.map((nodeId, index) => ({
          elementType: "node", action: "delete", osmId: nodeId, version: 1,
          before: { lat: coordinates[index][1], lng: coordinates[index][0], tags: {} }, after: null,
        })),
      ],
    });
    fixture = null;
    console.log(JSON.stringify({
      success: true, target: "development-osm", recordId: sessionId, wayId,
      publishChangesetId: publication.executionResult.changesetId,
      revertChangesetId: revert.executionResult.changesetId,
      publishIdempotent: true, revertIdempotent: true, auditVerified: true, fixtureRemoved: true,
    }));
  } finally {
    if (pool && typeof pool.end === "function") await pool.end().catch(() => {});
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
