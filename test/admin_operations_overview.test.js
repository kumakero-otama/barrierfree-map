const assert = require("assert");
const path = require("path");

process.env.STEPBY_HEALTH_CSV = path.join(__dirname, "fixtures", "hourly-health.csv");
const { readLatestHealthObservation } = require("../server/api/admin_database");

const observation = readLatestHealthObservation();
assert.strictEqual(observation.api_service, "active");
assert.strictEqual(observation.postgres_service, "active");
assert.strictEqual(observation.caddy_service, "active");
assert.strictEqual(observation.backup_last_result, "success");
assert.strictEqual(Number(observation.disk_used_percent), 14);
assert.strictEqual(Number(observation.api_http_status), 200);
assert.strictEqual(Number(observation.api_seconds), 0.061);
assert.strictEqual(Number(observation.errors_last_hour), 0);
assert.strictEqual(Number(observation.memory_available_mb) * 1024 * 1024, 448 * 1024 * 1024);
console.log(JSON.stringify({ result: "passed", observedAt: observation.timestamp_utc }));
