const assert = require("assert");
const fs = require("fs");
const path = require("path");

const tagSource = fs.readFileSync(path.join(__dirname, "../server/api/tactile_tags.js"), "utf8");
const proSource = fs.readFileSync(path.join(__dirname, "../server/api/pro_status.js"), "utf8");

assert.match(tagSource, /JOIN login\.users u ON u\.user_id = s\.user_id/,
  "session tag writes must load the authenticated record owner's current account type");
assert.match(tagSource, /if \(!Boolean\(sessionRows\[0\]\.is_pro\) && targetTag\.code !== "tactile_paving"\)/,
  "non-PRO accounts may save only the resolved standard tactile_paving tag");
assert.match(tagSource, /WHERE s\.session_id = \? AND s\.user_id = \?/,
  "the standard-tag exception must remain restricted to the authenticated owner's record");
assert.ok(tagSource.indexOf('targetTag.code !== "tactile_paving"') < tagSource.indexOf("INSERT INTO tactile.session_tags"),
  "the resolved-tag permission guard must run before any session tag insert");
assert.match(tagSource, /sendLoggedJson\(res, 403, \{ error: "pro_required" \}/,
  "rejected PRO tag writes must return a stable authorization error");
assert.match(proSource, /isPro: Boolean\(result\.user\.is_pro\)/,
  "guest accounts must receive their actual PRO state");
assert.doesNotMatch(proSource, /guest_pro_locked/,
  "guest accounts must be allowed to toggle PRO mode");

console.log("non-PRO custom tag writes are blocked, standard tags and guest PRO mode are supported server-side");
