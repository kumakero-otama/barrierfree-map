"use strict";
const assert = require("assert");
const { EventEmitter } = require("events");

// No DB, HTTP calls, OSM writes or disk logs are needed for these regressions.
function mockModule(relative, exports) {
  const filename = require.resolve(relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

async function testRecordQuery() {
  const queries = [];
  mockModule("../server/db", { createDbPool: () => ({ pool: {
    query: async (sql, params) => { queries.push({ sql, params }); return [[]]; },
  } }) });
  mockModule("../server/auth_user", { resolveAuthenticatedUserId: async () => 42 });
  mockModule("../server/pro_record_policy", { ensureProTagSchema: async () => {} });
  const createRecordsHandler = require("../server/api/records");
  let response;
  const handler = createRecordsHandler({ sendJson: (res, status, body) => { response = { status, body }; } });
  await handler({ method: "GET", url: "/api/records", headers: { host: "localhost" } }, {});
  assert.equal(response.status, 200);
  const { sql, params } = queries[0];
  assert.match(sql, /WHERE s\.is_active = true AND \(s\.user_id = \? OR COALESCE\(tag_info\.has_public, FALSE\)\s+OR \(migrated\.record_id IS NOT NULL AND NOT COALESCE\(tag_info\.has_private, FALSE\)\)\)/,
    "geometry must be filtered inside the SELECT, before the response exists");
  assert.deepEqual(params, [42, 42, 42]);
  assert.match(sql, /ELSE COALESCE\(tag_info\.public_tags/);
  assert.match(sql, /ELSE COALESCE\(tag_info\.public_tag_codes/);
  assert.match(sql, /FILTER \(WHERE t\.osm_exportable\) AS public_tags/);
  assert.match(sql, /FILTER \(WHERE t\.osm_exportable\) AS public_tag_codes/);
  await handler({ method: "GET", url: "/api/records?mine=1&centerLat=35&centerLng=139&radiusKm=2", headers: { host: "localhost" } }, {});
  assert.deepEqual(queries[1].params, [42, 42, 42, 139, 35, 2000, 42]);
}

function testRatePolicies() {
  process.env.ACCESS_TOKEN_SECRET = "test-only-access-secret-32-characters-long";
  process.env.DEV_ADMIN_KEY = "test-only-admin-secret-32-characters-long";
  mockModule("../server/logger", { createLogger: () => ({ appendLog() {} }) });
  const createGuard = require("../server/security/dev_api_guard");
  const { createAccessToken } = require("../server/auth_token");
  const guard = createGuard({ logDir: "/unused", allowedOrigins: [], sendJson: (res, status, body) => { res.status = status; res.body = body; } });
  let user = 1;
  function request(pathname, ip, options = {}) {
    const req = new EventEmitter();
    Object.assign(req, { url: pathname, method: options.method || "GET", socket: { remoteAddress: ip }, headers: {
      host: "localhost", authorization: `Bearer ${createAccessToken(options.user || user++)}`,
      ...options.headers,
    } });
    const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
    return { allowed: guard(req, res), res, req };
  }
  // Different users isolate the shared-IP cap from each user's lower cap.
  for (let i = 0; i < 30; i++) assert.equal(request("/api/osm-tactile-ways", "network-ip").allowed, true);
  const blockedNetwork = request("/api/osm-walkable-network", "network-ip");
  assert.equal(blockedNetwork.res.status, 429);
  assert.ok(Number(blockedNetwork.res.headers["Retry-After"]) > 0);
  assert.equal(request("/api/trace", "network-ip", { method: "POST" }).allowed, true);
  assert.equal(request("/api/records", "network-ip").allowed, true);
  for (let i = 0; i < 31; i++) assert.equal(request("/api/records", "read-ip").allowed, true);
  assert.equal(request("/api/trace", "read-ip", { method: "POST" }).allowed, true);
  assert.equal(request("/api/osm-tactile-ways", "read-ip").allowed, true);
  for (let i = 0; i < 30; i++) assert.equal(request("/api/trace", "trace-ip", { method: "POST" }).allowed, true);
  assert.equal(request("/api/trace", "trace-ip", { method: "POST" }).res.status, 429);
  assert.equal(request("/api/records", "trace-ip").allowed, true);
  for (let i = 0; i < 15; i++) assert.equal(request("/api/osm-tactile-ways", "user-ip", { user: 9999 }).allowed, true);
  assert.equal(request("/api/osm-tactile-ways", "user-ip", { user: 9999 }).res.status, 429);
  assert.equal(request("/api/trace", "user-ip", { method: "POST", user: 9999 }).allowed, true);
  assert.equal(request("/api/records", "auth-ip", { headers: { authorization: "Bearer invalid" } }).res.status, 401);
  assert.equal(request("/api/records", "origin-ip", { headers: { origin: "https://attacker.invalid" } }).res.status, 403);
  // The global coarse cap remains shared across policy groups and public routes.
  for (let i = 0; i < 300; i++) {
    const result = request(`/api/public/${i % 2 ? "stats" : "tactile-ranking"}`, "coarse-ip");
    assert.equal(result.allowed, true);
  }
  assert.equal(request("/api/trace", "coarse-ip", { method: "POST" }).res.status, 429);
}

async function testSessionInfoPrivacy() {
  let fixture = [];
  mockModule("../server/db", { createDbPool: () => ({ pool: {
    query: async (sql, params) => {
      if (!sql.includes("AS has_public_tags")) return [[]];
      assert.match(sql, /CASE WHEN s\.user_id = \? THEN s\.memo ELSE NULL END AS memo/);
      assert.match(sql, /WHEN s\.user_id = \? OR COALESCE\(t\.osm_exportable, FALSE\)/);
      assert.deepEqual(params, [42, 42, "record-id"]);
      // Emulate SQL's existing owner-only memo/public-only tag projection.
      return [fixture.map((row) => ({ ...row,
        memo: row.user_id === 42 ? "private memo" : null,
        tag_label_ja: row.user_id === 42 || row.osm_exportable ? row.label : null,
      }))];
    },
  } }) });
  const createHandler = require("../server/api/tactile_tags");
  let response;
  const handler = createHandler({ sendJson: (res, status, body) => { response = { status, body }; } });
  async function run(rows) {
    fixture = rows;
    await handler({ method: "GET", url: "/api/tactile-session-info?sessionId=record-id", headers: { host: "localhost" }, authUserId: 42 }, {});
    return response;
  }
  const privateRow = { user_id: 7, username: "secret-owner", label: "private-tag", has_public_tags: false, has_private_tags: true };
  assert.deepEqual(await run([privateRow]), { status: 404, body: { error: "session_not_found" } });
  assert.equal((await run([{ ...privateRow, legacy_record_id: "migrated" }])).status, 404);
  assert.equal((await run([{ ...privateRow, user_id: 42 }])).body.session.memo, "private memo");
  const mixed = await run([
    { ...privateRow, has_public_tags: true },
    { ...privateRow, label: "public-tag", has_public_tags: true, osm_exportable: true },
  ]);
  assert.deepEqual(mixed.body.session.tags, ["public-tag"]);
  assert.equal(mixed.body.session.memo, "");
  assert.equal((await run([{ ...privateRow, has_private_tags: false, legacy_record_id: "migrated" }])).status, 200);
  assert.equal((await run([{ ...privateRow, has_private_tags: false }])).status, 404);
}

testRecordQuery().then(async () => {
  testRatePolicies();
  await testSessionInfoPrivacy();
  console.log("records SQL privacy and genuine signed-token guard rate policy regressions passed");
}).catch((error) => { console.error(error); process.exitCode = 1; });
