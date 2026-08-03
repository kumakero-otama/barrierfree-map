const assert = require("assert");
const { createSplitPlan } = require("../server/osm/split_planner");

function way(overrides = {}) {
  return {
    wayId: 100,
    wayVersion: 7,
    nodes: [10, 11, 12, 13],
    fullCoordinates: [[139, 35], [139.001, 35], [139.002, 35], [139.003, 35]],
    tags: { highway: "footway", surface: "paved" },
    from: { kind: "projection", segmentIndex: 0, fraction: 0.5, coordinate: [139.0005, 35] },
    to: { kind: "projection", segmentIndex: 2, fraction: 0.5, coordinate: [139.0025, 35] },
    ...overrides,
  };
}

function run() {
  const middle = createSplitPlan({ segments: [way()] });
  assert.deepStrictEqual(middle.summary, { sourceWays: 1, createdNodes: 2, createdWays: 2, modifiedWays: 1, operationCount: 5 });
  assert.strictEqual(middle.ways[0].sections.length, 3);
  assert.deepStrictEqual(middle.ways[0].sections.map((s) => s.tactile), [false, true, false]);
  assert.strictEqual(middle.ways[0].sections[1].tags.tactile_paving, "yes");
  assert.strictEqual(middle.ways[0].sections[0].tags.tactile_paving, undefined);

  const whole = createSplitPlan({ segments: [way({
    from: { kind: "node", index: 0 }, to: { kind: "node", index: 3 },
  })] });
  assert.strictEqual(whole.summary.createdNodes, 0);
  assert.strictEqual(whole.summary.createdWays, 0);
  assert.strictEqual(whole.operations.length, 1);
  assert.strictEqual(whole.operations[0].after.tags.tactile_paving, "yes");

  const reverse = createSplitPlan({ segments: [way({
    from: { kind: "projection", segmentIndex: 2, fraction: 0.5 },
    to: { kind: "projection", segmentIndex: 0, fraction: 0.5 },
  })] });
  assert.deepStrictEqual(reverse.ways[0].sections.map((s) => s.tactile), [false, true, false]);

  const existingNodes = createSplitPlan({ segments: [way({
    from: { kind: "node", index: 1 }, to: { kind: "node", index: 2 },
  })] });
  assert.strictEqual(existingNodes.summary.createdNodes, 0);
  assert.strictEqual(existingNodes.summary.createdWays, 2);
  assert.deepStrictEqual(existingNodes.ways[0].sections.map((s) => s.tactile), [false, true, false]);

  const multi = createSplitPlan({ segments: [
    way({ wayId: 100, from: { kind: "projection", segmentIndex: 1, fraction: 0.5 }, to: { kind: "node", index: 3 } }),
    way({ wayId: 200, nodes: [13, 20, 21], fullCoordinates: [[139.003,35],[139.004,35],[139.005,35]], from: { kind: "node", index: 0 }, to: { kind: "projection", segmentIndex: 1, fraction: 0.5 } }),
  ] });
  assert.strictEqual(multi.summary.sourceWays, 2);
  assert.strictEqual(multi.summary.createdNodes, 2);
  assert.strictEqual(multi.ways[0].sections.filter((s) => s.tactile).length, 1);
  assert.strictEqual(multi.ways[1].sections.filter((s) => s.tactile).length, 1);

  assert.throws(() => createSplitPlan({ segments: [way(), way()] }), /duplicate_way_in_route/);
  assert.strictEqual(middle.osmSent, false);
  console.log("osm_split_planner: all tests passed");
}
run();
