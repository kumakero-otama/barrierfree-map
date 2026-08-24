const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "../server/api/osm_changes.js"), "utf8");
const oauthSource = fs.readFileSync(path.join(__dirname, "../server/api/osm_oauth.js"), "utf8");
const tactileSource = fs.readFileSync(path.join(__dirname, "../server/api/osm_tactile.js"), "utf8");
const tagSource = fs.readFileSync(path.join(__dirname, "../server/api/tactile_tags.js"), "utf8");
assert.match(source, /parts\[4\] === "publish"/);
assert.match(source, /administrator_review_required/);
assert.match(source, /parts\[2\] === "reviews"/);
assert.match(source, /isReviewAdmin\(pool, req\.authUserId\)/);
assert.match(source, /guest_review_excluded/);
assert.match(source, /enqueueReview/);
assert.match(source, /parts\[4\] === "revert"/);
assert.match(tactileSource, /stepby_record_id = String\(record\.record_id\)/,
  "all users need a record id for read-only detail display");
assert.match(tactileSource, /stepby_owner_user_id = Number\(record\.created_by\)/,
  "detail cards need the real owner while deletion remains owner-only");
assert.match(tagSource, /ownerUserId: first\.user_id/,
  "session details must identify the owner to the UI");
assert.match(source, /body\.authorization !== "owned_green_line_delete"/);
assert.match(source, /requireOwnedRecord\(recordId, req\.authUserId\)/);
assert.match(source, /pg_advisory_lock/);
assert.match(source, /user_execution_requested/);
assert.match(source, /osm_version_conflict/);
assert.match(source, /publication_skipped_existing_tactile/);
assert.match(source, /status: "already_present"/);
assert.match(source, /createServiceAccountOsmClient/);
assert.doesNotMatch(source, /createUserOsmClient/);
assert.match(oauthSource, /individual_osm_oauth_retired/);
assert.match(oauthSource, /tryHandleServiceCallback[\s\S]*?return sendJson\(res, 410/,
  "unknown callbacks must never revive legacy per-user OSM authorization");

console.log("OSM user publication/revert policy tests passed; no OSM network used");
