"use strict";

const assert = require("assert");
const { assertSecurityConfiguration } = require("../server/security/security_config");

assert.throws(
  () => assertSecurityConfiguration({ DEV_ADMIN_KEY: "a".repeat(32) }),
  /ACCESS_TOKEN_SECRET_missing/
);
assert.throws(
  () => assertSecurityConfiguration({ ACCESS_TOKEN_SECRET: "a".repeat(31), DEV_ADMIN_KEY: "b".repeat(32) }),
  /ACCESS_TOKEN_SECRET_too_short/
);
assert.throws(
  () => assertSecurityConfiguration({ ACCESS_TOKEN_SECRET: "a".repeat(32), DEV_ADMIN_KEY: "b".repeat(31) }),
  /DEV_ADMIN_KEY_too_short/
);
const configured = assertSecurityConfiguration({
  ACCESS_TOKEN_SECRET: "a".repeat(32),
  DEV_ADMIN_KEY: "b".repeat(32),
});
assert.strictEqual(configured.accessTokenSecret.length, 32);
assert.strictEqual(configured.adminKey.length, 32);
console.log("security configuration fails closed for missing or short secrets");
