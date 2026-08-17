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

  let rebasedAudit = null;
  let uploadedVersion = null;
  const restoredClient = {
    async fetchElementSnapshot() {
      return { version: 16, nodes: [1, 2], tags: { highway: "residential" }, members: [] };
    },
    async createChangeset() { return 456; },
    async uploadChangeset(_changesetId, operations) {
      uploadedVersion = operations[0].version;
      return { temporaryIds: {}, diffResult: [{ elementType: "way", oldId: 100, newId: 100, newVersion: 17 }] };
    },
    async closeChangeset() {},
  };
  const rebased = await executeWithClient({
    client: restoredClient,
    operations: [{ elementType: "way", action: "modify", osmId: 100, version: 14,
      before: { nodes: [1, 2], tags: { highway: "residential" } },
      after: { nodes: [1, 2], tags: { highway: "residential", "sidewalk:right:tactile_paving": "yes" } } }],
    summary: "same content after prior revert",
    planId: "mock-rebase-plan",
    operationType: "merge",
    onVersionsRebased: async (items) => { rebasedAudit = items; },
  });
  assert.strictEqual(uploadedVersion, 16, "内容が同一ならOSMの最新Versionを使う");
  assert.deepStrictEqual(rebasedAudit, [{ elementType: "way", osmId: 100, fromVersion: 14, toVersion: 16 }]);
  assert.strictEqual(rebased.versionRebases.length, 1);
  console.log("osm_executor_conflict: mocked conflict stopped before changeset; no OSM network used");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
