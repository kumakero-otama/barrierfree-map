const assert = require("assert");
const { createExecutableRevert } = require("../server/osm/revert_planner");

const source = [
  { elementType: "node", action: "create", osmId: null, version: null, before: null, after: { temporaryId: "new-node-1", lat: 35, lng: 139, tags: {} } },
  { elementType: "way", action: "modify", osmId: 100, version: 7, before: { nodes: [10, 11], tags: { highway: "footway" } }, after: { nodes: [10, "new-node-1"], tags: { highway: "footway", tactile_paving: "yes" } } },
];
const execution = {
  temporaryIds: { "new-node-1": -1 },
  diffResult: [
    { elementType: "node", oldId: -1, newId: 900, newVersion: 1 },
    { elementType: "way", oldId: 100, newId: 100, newVersion: 8 },
  ],
};
const reversed = createExecutableRevert(source, execution);
assert.deepStrictEqual(reversed[0], {
  elementType: "way", action: "modify", osmId: 100, version: 8,
  before: { nodes: [10, 900], tags: { highway: "footway", tactile_paving: "yes" } },
  after: { nodes: [10, 11], tags: { highway: "footway" } },
});
assert.strictEqual(reversed[1].action, "delete");
assert.strictEqual(reversed[1].osmId, 900);
assert.strictEqual(reversed[1].version, 1);
assert.throws(() => createExecutableRevert(source, { temporaryIds: {}, diffResult: [] }), /incomplete_osm_diff_result/);
console.log("osm_revert_planner: mocked tests passed; no OSM network used");
