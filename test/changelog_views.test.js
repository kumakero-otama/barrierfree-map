const assert = require("assert");
const { EventEmitter } = require("events");
const { createChangelogViewsHandler, normalizeItems } = require("../server/api/changelog_views");

function responseCapture() {
  return {
    status: null,
    body: null,
    send(status, payload) { this.status = status; this.body = payload; },
  };
}

function request(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { host: "localhost" };
  setImmediate(() => {
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

(async () => {
  assert.strictEqual(normalizeItems([{ itemId: "1.29.1.help-form", text: "フォームを整備" }]).length, 1);
  assert.strictEqual(normalizeItems([{ itemId: "bad id", text: "x" }]), null);

  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT item_id/.test(sql)) {
        return [[{
          item_id: "1.29.1.help-form",
          changelog_version: "1.29.1",
          language: "ja",
          content_hash: "a".repeat(64),
          first_displayed_at: "2026-10-04T00:00:00.000Z",
        }]];
      }
      return [{ affectedRows: 1 }];
    },
  };
  const sendJson = (res, status, payload) => res.send(status, payload);
  const handler = createChangelogViewsHandler({
    sendJson,
    poolOverride: pool,
    resolveUserId: async () => 42,
  });

  const postRes = responseCapture();
  await handler(request("POST", {
    version: "1.29.1",
    language: "ja",
    items: [
      { itemId: "1.29.1.help-form", text: "フォームを整備" },
      { itemId: "1.29.1.pro-faq", text: "PROモードFAQ" },
    ],
  }), postRes);
  assert.strictEqual(postRes.status, 200);
  assert.deepStrictEqual(postRes.body.recorded, ["1.29.1.help-form", "1.29.1.pro-faq"]);
  assert.strictEqual(queries.filter((entry) => /INSERT INTO login\.changelog_item_views/.test(entry.sql)).length, 2);

  const getRes = responseCapture();
  await handler(request("GET"), getRes);
  assert.strictEqual(getRes.status, 200);
  assert.strictEqual(getRes.body.items[0].itemId, "1.29.1.help-form");
  console.log("changelog view API records exact items per authenticated user");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
