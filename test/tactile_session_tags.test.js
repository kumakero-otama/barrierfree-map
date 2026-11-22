const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { Readable } = require("stream");

// Load with isolated dependencies: no real database, audit files, or OSM calls.
const source = fs.readFileSync(path.join(__dirname, "../server/api/tactile_tags.js"), "utf8");

async function request({ body, isPro = false, owner = true, authenticated = true, existing = false, missingTag = false }) {
  const queries = [];
  const logs = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/FROM tactile.sessions s/.test(sql)) {
        assert.deepStrictEqual(Array.from(params), ["own-session", 7]);
        assert.match(sql, /s.session_id = \? AND s.user_id = \?/);
        return [owner ? [{ session_id: "own-session", is_pro: isPro }] : []];
      }
      if (/FROM tactile.tags\s+WHERE/.test(sql)) {
        const code = typeof params[0] === "number"
          ? (params[0] === 1 ? "tactile_paving" : "private_tag") : params[0];
        return [missingTag ? [] : [{ id: code === "tactile_paving" ? 1 : 2, code }]];
      }
      if (/FROM tactile.session_tags st/.test(sql)) {
        return [existing ? [{ session_id: "own-session", tag_id: 1, code: "tactile_paving" }] : []];
      }
      if (/INSERT INTO tactile.session_tags/.test(sql)) {
        return [[{ session_id: params[0], tag_id: params[1], code: params[1] === 1 ? "tactile_paving" : "private_tag" }]];
      }
      return [[]];
    },
  };
  const moduleStub = { exports: {} };
  vm.runInNewContext(source, {
    module: moduleStub,
    __dirname: path.join(__dirname, "../server/api"),
    URL,
    console,
    require(name) {
      if (name === "../db") return { createDbPool: () => ({ pool }) };
      if (name === "../auth_user") return { resolveAuthenticatedUserId: async () => authenticated ? 7 : null };
      if (name === "../logger") return { createLogger: () => ({ appendLog: (...args) => logs.push(args) }) };
      if (name === "../pro_record_policy") return { ensureProTagSchema: async () => {} };
      if (name === "path") return path;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  let response;
  const handler = moduleStub.exports({ sendJson: (_res, status, payload) => { response = { status, payload }; } });
  const req = Readable.from([JSON.stringify({ sessionId: "own-session", ...body })]);
  Object.assign(req, { url: "/api/session-tags", method: "POST", headers: { host: "localhost" } });
  await handler(req, {});
  assert.strictEqual(logs.length, 1, "every save response is audited");
  return { ...response, queries };
}

(async () => {
  for (const body of [{ tagCode: "tactile_paving" }, { tagId: 1 }]) {
    const result = await request({ body });
    assert.strictEqual(result.status, 201, "normal users can save the standard tag");
    assert.strictEqual(result.payload.sessionTag.tagCode, "tactile_paving");
  }
  const duplicate = await request({ body: { tagId: 1 }, existing: true });
  assert.strictEqual(duplicate.status, 200);
  assert.strictEqual(duplicate.payload.created, false);
  for (const body of [
    { tagCode: "private_tag" }, { tagCode: "tactile_paving_jis" },
    { tagCode: "tactile_paving_non_jis" }, { tagId: 2, tagCode: "tactile_paving" },
  ]) {
    const result = await request({ body });
    assert.strictEqual(result.status, 403);
    assert.strictEqual(result.payload.error, "pro_required");
    assert.ok(!result.queries.some(({ sql }) => /INSERT INTO tactile.session_tags/.test(sql)));
  }
  for (const body of [{ tagCode: "private_tag" }, { tagId: 2 }]) {
    assert.strictEqual((await request({ body, isPro: true })).status, 201, "Pro users retain arbitrary tags");
  }
  const forbidden = await request({ body: { tagCode: "tactile_paving" }, owner: false });
  assert.strictEqual(forbidden.status, 404);
  assert.strictEqual(forbidden.payload.error, "session_not_found_or_forbidden");
  assert.ok(!forbidden.queries.some(({ sql }) => /INSERT INTO tactile.session_tags/.test(sql)));
  assert.strictEqual((await request({ body: { tagId: 1 }, authenticated: false })).status, 401);
  assert.strictEqual((await request({ body: { tagId: 1 }, missingTag: true })).status, 404);
  console.log("session tag permissions passed (mock database only)");
})().catch((error) => { console.error(error); process.exitCode = 1; });
