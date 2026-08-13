const assert = require("assert");
const { executeWithClient } = require("../server/osm/osm_executor");

async function run() {
  let changesetCalls = 0;
  let uploadCalls = 0;
  const client = {
    async fetchElementVersion(type, id) {
      assert.strictEqual(type, "way");
      assert.strictEqual(id, 100);
      return 9; // StepByが記録したversion 8の後に第三者編集が入った想定
    },
    async createChangeset() { changesetCalls += 1; return 123; },
    async uploadChangeset() { uploadCalls += 1; throw new Error("must_not_upload"); },
    async closeChangeset() {},
  };
  await assert.rejects(
    executeWithClient({
      client,
      operations: [{ elementType: "way", action: "modify", osmId: 100, version: 8,
        before: { nodes: [1, 2], tags: { tactile_paving: "yes" } },
        after: { nodes: [1, 2], tags: {} } }],
      summary: "mock revert",
      planId: "mock-plan",
      operationType: "revert",
    }),
    (error) => error.message === "osm_version_conflict" && error.expectedVersion === 8 && error.currentVersion === 9,
  );
  assert.strictEqual(changesetCalls, 0, "競合時はchangeset自体を作らない");
  assert.strictEqual(uploadCalls, 0, "競合時は第三者編集を上書きしない");
  console.log("osm_executor_conflict: mocked conflict stopped before changeset; no OSM network used");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
