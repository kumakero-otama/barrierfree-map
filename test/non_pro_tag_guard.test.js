const assert = require("assert");
const fs = require("fs");
const path = require("path");

const tagSource = fs.readFileSync(path.join(__dirname, "../server/api/tactile_tags.js"), "utf8");
const proSource = fs.readFileSync(path.join(__dirname, "../server/api/pro_status.js"), "utf8");

assert.match(tagSource, /JOIN login\.users u ON u\.user_id = s\.user_id/,
  "session tag writes must load the authenticated record owner's current account type");
assert.match(tagSource, /!Boolean\(sessionRows\[0\]\.is_pro\) \|\| Boolean\(sessionRows\[0\]\.is_guest\)/,
  "non-PRO and guest accounts must be rejected before any session tag insert");
assert.match(tagSource, /sendLoggedJson\(res, 403, \{ error: "pro_required" \}/,
  "rejected PRO tag writes must return a stable authorization error");
assert.match(proSource, /isPro: !Boolean\(result\.user\.is_guest\) && Boolean\(result\.user\.is_pro\)/,
  "guest accounts must always be reported as non-PRO");

console.log("non-PRO and guest tactile tag writes are blocked server-side");
