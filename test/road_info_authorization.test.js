const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  configuredAdminEmails,
  isRoadInfoAdmin,
  isPointOwner,
} = require("../server/road_info_authorization");

assert.deepStrictEqual(
  configuredAdminEmails({ ROAD_INFO_ADMIN_EMAILS: "ADMIN@example.com, second@example.com, admin@example.com" }),
  ["admin@example.com", "second@example.com"]
);
assert.deepStrictEqual(
  configuredAdminEmails({ OSM_REVIEW_ADMIN_EMAIL: "review@example.com" }),
  ["review@example.com"]
);
assert.deepStrictEqual(configuredAdminEmails({}), []);
assert.strictEqual(isPointOwner(12, 12), true);
assert.strictEqual(isPointOwner(12, 13), false);
assert.strictEqual(isPointOwner(null, 13), false);

const handlerSource = fs.readFileSync(path.join(__dirname, "../server/api/road_info.js"), "utf8");
assert.match(handlerSource, /LIMIT 1\s+FOR UPDATE/, "対象ポイントをトランザクション内でロックする");
assert.match(handlerSource, /WHERE id = \? AND created_by = \?/, "所有者更新はSQLのcreated_by条件でも保護する");
assert.match(handlerSource, /sendJson\(res, 403, \{ error: "point_state_forbidden" \}\)/);

(async () => {
  const calls = [];
  const allowedConn = {
    async query(sql, params) {
      calls.push({ sql, params });
      return [[{ allowed: 1 }]];
    },
  };
  assert.strictEqual(await isRoadInfoAdmin(allowedConn, 42, {
    ROAD_INFO_ADMIN_EMAILS: "admin@example.com,owner@example.com",
  }), true);
  assert.match(calls[0].sql, /provider = 'google'/);
  assert.match(calls[0].sql, /LOWER\(email\) IN \(\?, \?\)/);
  assert.deepStrictEqual(calls[0].params, [42, "admin@example.com", "owner@example.com"]);

  const deniedConn = { async query() { return [[]]; } };
  assert.strictEqual(await isRoadInfoAdmin(deniedConn, 42, {
    ROAD_INFO_ADMIN_EMAILS: "admin@example.com",
  }), false);
  assert.strictEqual(await isRoadInfoAdmin(deniedConn, 42, {}), false);
  console.log("road info state changes are restricted to the owner or an explicitly configured Google admin");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
