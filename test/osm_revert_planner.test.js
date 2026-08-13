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

// Way途中の記録を3分割した場合、取消しはタグだけを消すのではなく、元Wayの
// Node列を完全復元し、分割時に作ったWayと境界Nodeを削除し、Relationも戻す。
const splitSource = [
  { elementType: "node", action: "create", osmId: null, version: null, before: null,
    after: { temporaryId: "boundary-1", lat: 35, lng: 139.0005, tags: {} } },
  { elementType: "node", action: "create", osmId: null, version: null, before: null,
    after: { temporaryId: "boundary-2", lat: 35, lng: 139.0025, tags: {} } },
  { elementType: "way", action: "modify", osmId: 100, version: 7,
    before: { nodes: [10, 11, 12, 13], tags: { highway: "residential" } },
    after: { nodes: [10, "boundary-1"], tags: { highway: "residential" } } },
  { elementType: "way", action: "create", osmId: null, version: null, before: null,
    after: { temporaryId: "tactile-way", nodes: ["boundary-1", 11, 12, "boundary-2"],
      tags: { highway: "residential", "sidewalk:right:tactile_paving": "yes" } } },
  { elementType: "way", action: "create", osmId: null, version: null, before: null,
    after: { temporaryId: "tail-way", nodes: ["boundary-2", 13], tags: { highway: "residential" } } },
  { elementType: "relation", action: "modify", osmId: 900, version: 3,
    before: { members: [{ type: "way", ref: 100, role: "forward" }], tags: { type: "route" } },
    after: { members: [
      { type: "way", ref: 100, role: "forward" },
      { type: "way", ref: "tactile-way", role: "forward" },
      { type: "way", ref: "tail-way", role: "forward" },
    ], tags: { type: "route" } } },
];
const splitExecution = {
  temporaryIds: { "boundary-1": -1, "boundary-2": -2, "tactile-way": -3, "tail-way": -4 },
  diffResult: [
    { elementType: "node", oldId: -1, newId: 901, newVersion: 1 },
    { elementType: "node", oldId: -2, newId: 902, newVersion: 1 },
    { elementType: "way", oldId: 100, newId: 100, newVersion: 8 },
    { elementType: "way", oldId: -3, newId: 903, newVersion: 1 },
    { elementType: "way", oldId: -4, newId: 904, newVersion: 1 },
    { elementType: "relation", oldId: 900, newId: 900, newVersion: 4 },
  ],
};
const splitRevert = createExecutableRevert(splitSource, splitExecution);
const restoredOriginalWay = splitRevert.find((item) => item.elementType === "way" && item.osmId === 100);
assert.deepStrictEqual(restoredOriginalWay.after.nodes, [10, 11, 12, 13]);
assert.deepStrictEqual(restoredOriginalWay.after.tags, { highway: "residential" });
assert.deepStrictEqual(splitRevert.filter((item) => item.elementType === "way" && item.action === "delete")
  .map((item) => item.osmId).sort(), [903, 904]);
assert.deepStrictEqual(splitRevert.filter((item) => item.elementType === "node" && item.action === "delete")
  .map((item) => item.osmId).sort(), [901, 902]);
const restoredRelation = splitRevert.find((item) => item.elementType === "relation" && item.osmId === 900);
assert.deepStrictEqual(restoredRelation.after.members, [{ type: "way", ref: 100, role: "forward" }]);
console.log("osm_revert_planner: mocked tests passed; no OSM network used");
