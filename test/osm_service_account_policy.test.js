const assert = require("assert");

process.env.OSM_SERVICE_ACCESS_TOKEN = "test-token-never-sent";
process.env.OSM_SERVICE_ACCOUNT_NAME = "StepBy-test";
process.env.OSM_API_BASE_URL = "https://api.openstreetmap.test";
process.env.OSM_CHANGESET_HASHTAG = "#StepBy";
process.env.OSM_AUTOMATED_EDIT_WIKI_URL = "https://wiki.openstreetmap.org/wiki/Automated_edits/StepBy";
process.env.OSM_AUTOMATED_EDIT_TAG = "mechanical";
process.env.STEPBY_VERSION = "test";

const { serviceAccountConfig, createServiceAccountOsmClient } = require("../server/osm/service_account_client");
const { changesetMetadata } = require("../server/osm/osm_executor");

assert.strictEqual(serviceAccountConfig().configured, true);
assert.ok(createServiceAccountOsmClient(), "service account client is created from server-only configuration");
const tags = changesetMetadata("StepBy field survey: tactile paving confirmed");
assert.strictEqual(tags.source, "survey");
assert.strictEqual(tags.mechanical, "yes");
assert.strictEqual(tags.description, process.env.OSM_AUTOMATED_EDIT_WIKI_URL);
assert.match(tags.comment, /#StepBy/);
assert.doesNotMatch(JSON.stringify(tags), /plan_id|user_id/);
console.log("central OSM service account metadata policy passed without network access");
