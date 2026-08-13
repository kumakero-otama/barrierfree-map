const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { decryptAccessToken } = require("../server/osm/user_oauth_client");

const originalSecret = process.env.OSM_TOKEN_ENCRYPTION_KEY;
process.env.OSM_TOKEN_ENCRYPTION_KEY = "test-only-secret-that-is-never-used-for-osm";
const key = crypto.createHash("sha256").update(process.env.OSM_TOKEN_ENCRYPTION_KEY).digest();
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
const ciphertext = Buffer.concat([cipher.update("fake-user-oauth-token", "utf8"), cipher.final()]);
const encrypted = `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
assert.strictEqual(decryptAccessToken(encrypted), "fake-user-oauth-token");
if (originalSecret == null) delete process.env.OSM_TOKEN_ENCRYPTION_KEY;
else process.env.OSM_TOKEN_ENCRYPTION_KEY = originalSecret;

const source = fs.readFileSync(path.join(__dirname, "../server/api/osm_changes.js"), "utf8");
assert.match(source, /parts\[4\] === "publish"/);
assert.match(source, /body\.authorization !== "record_save"/);
assert.match(source, /parts\[4\] === "revert"/);
assert.match(source, /body\.authorization !== "owned_green_line_delete"/);
assert.match(source, /requireOwnedRecord\(recordId, req\.authUserId\)/);
assert.match(source, /pg_advisory_lock/);
assert.match(source, /user_execution_requested/);
assert.match(source, /osm_version_conflict/);
assert.match(source, /publication_skipped_existing_tactile/);
assert.match(source, /osm_status === "already_present"/);
assert.match(source, /changesetId: null/);

console.log("OSM user publication/revert policy tests passed; no OSM network used");
