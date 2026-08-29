const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migrationTool = fs.readFileSync(path.join(__dirname, "..", "tools", "materialize_legacy_records.js"), "utf8");
const recordsApi = fs.readFileSync(path.join(__dirname, "..", "server", "api", "records.js"), "utf8");
const sessionInfoApi = fs.readFileSync(path.join(__dirname, "..", "server", "api", "tactile_tags.js"), "utf8");

assert.match(migrationTool, /--confirm-new-db-only/);
assert.match(migrationTool, /FROM osmchange\.review_queue WHERE source_type='legacy_record'/);
assert.match(migrationTool, /ON CONFLICT\(source_digest\) DO NOTHING/);
assert.match(migrationTool, /INSERT INTO tactile\.sessions/);
assert.match(migrationTool, /INSERT INTO tactile\.gps_raw/);
assert.match(migrationTool, /INSERT INTO tactile\.session_paths/);
assert.match(migrationTool, /sourceDatabaseWritten: false, osmSent: false/);
assert.doesNotMatch(migrationTool, /openstreetmap\.org|executeWithClient|createChangeset/);
assert.match(recordsApi, /migration\.legacy_record_sources/);
assert.match(recordsApi, /ARRAY\['点字ブロック'\]/);
assert.match(sessionInfoApi, /COALESCE\(u\.username,m\.original_username\)/);

console.log("legacy_materialization_policy.test.js: OK");
