"use strict";

const assert = require("assert");
const { requireGuardedAdmin } = require("../server/security/admin_authorization");

const rejected = {};
assert.strictEqual(requireGuardedAdmin({}, rejected, (res, status, payload) => {
  res.status = status;
  res.payload = payload;
}), false);
assert.strictEqual(rejected.status, 403);
assert.strictEqual(rejected.payload.error, "admin_required");

assert.strictEqual(requireGuardedAdmin({
  stepByAdminAuthorized: true,
  authUserId: "admin-session",
}, {}, () => {
  throw new Error("authorized request must not send an error");
}), true);

console.log("admin handlers require the common guard authorization marker");
