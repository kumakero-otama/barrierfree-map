const assert = require("node:assert/strict");
const dbPath = require.resolve("../server/db");
let captured;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  createDbPool: () => ({ pool: { query: async (sql, args) => {
    captured = { sql, args };
    const points = [
      { time: "2026-11-22T14:59:59.999Z", length: 10 },
      { time: "2026-11-22T15:00:00.000Z", length: 20 },
      { time: "2026-11-22T23:30:00.000Z", length: 30 }, // 11/23 8:30 JST
      { time: "2026-11-23T00:00:00.000Z", length: 40 },
      { time: "2026-11-23T15:00:00.000Z", length: 50 },
    ];
    return [[{ total_tactile_length_meters: points.filter(p => p.time < args[1]).reduce((n,p) => n+p.length,0) }]];
  } } }),
} };
const createHandler = require("../server/api/stats");
assert.equal(createHandler.parseTargetDate(null, new Date("2026-11-22T14:59:59Z")), "2026-11-22");
assert.equal(createHandler.parseTargetDate(null, new Date("2026-11-22T15:00:00Z")), "2026-11-23");
assert.equal(createHandler.parseTargetDate("2026-02-30"), null);
assert.equal(createHandler.jstExclusiveEnd("2026-11-22"), "2026-11-22T15:00:00.000Z");
assert.equal(createHandler.jstExclusiveEnd("2026-12-31"), "2026-12-31T15:00:00.000Z");
assert.equal(createHandler.jstExclusiveEnd("2028-02-29"), "2028-02-29T15:00:00.000Z");
let result;
const handler = createHandler({ sendJson: (_, status, body) => { result = { status, body }; } });
(async () => {
  await handler({ method: "GET", url: "/api/public/stats?date=2026-11-22", headers: { host: "test" } }, {});
  assert.equal(result.body.totalTactileLengthMeters, 10);
  await handler({ method: "GET", url: "/api/public/stats?date=2026-11-23", headers: { host: "test" } }, {});
  assert.equal(result.body.totalTactileLengthMeters, 100);
  assert.equal(result.body.timeZone, "Asia/Tokyo");
  assert.deepEqual(captured.args, Array(3).fill("2026-11-23T15:00:00.000Z"));
  assert.match(captured.sql, /s\.started_at < \(\?::timestamptz AT TIME ZONE 'UTC'\)/);
  assert.match(captured.sql, /created_at < \?::timestamptz\) AS total_road_info_posts/);
  assert.doesNotMatch(captured.sql, /UPDATE|DELETE|INSERT|SET TIME ZONE/);
  console.log("JST statistics boundaries and morning recordings passed; database timestamps unchanged");
})().catch(error => { console.error(error); process.exitCode = 1; });
