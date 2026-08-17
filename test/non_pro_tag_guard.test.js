const assert = require("assert");
const fs = require("fs");
const path = require("path");

const tagSource = fs.readFileSync(path.join(__dirname, "../server/api/tactile_tags.js"), "utf8");
const proSource = fs.readFileSync(path.join(__dirname, "../server/api/pro_status.js"), "utf8");

assert.match(tagSource, /JOIN login\.users u ON u\.user_id = s\.user_id/,
  "session tag writes must load the authenticated record owner's current account type");
assert.match(tagSource, /if \(!Boolean\(sessionRows\[0\]\.is_pro\)\)/,
  "all non-PRO accounts must be rejected before any session tag insert");
assert.match(tagSource, /sendLoggedJson\(res, 403, \{ error: "pro_required" \}/,
  "rejected PRO tag writes must return a stable authorization error");
assert.match(proSource, /isPro: Boolean\(result\.user\.is_pro\)/,
  "guest accounts must receive their actual PRO state");
assert.doesNotMatch(proSource, /guest_pro_locked/,
  "guest accounts must be allowed to toggle PRO mode");

console.log("non-PRO tag writes are blocked and guest PRO mode is supported server-side");
