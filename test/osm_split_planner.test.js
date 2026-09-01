const assert = require("assert");
const { createSplitPlan } = require("../server/osm/split_planner");

function way(overrides = {}) {
  return {
    wayId: 100,
    wayVersion: 7,
    nodes: [10, 11, 12, 13],
    fullCoordinates: [[139, 35], [139.001, 35], [139.002, 35], [139.003, 35]],
    tags: { highway: "footway", surface: "paved", tactile_paving: "no" },
    from: { kind: "projection", segmentIndex: 0, fraction: 0.5, coordinate: [139.0005, 35] },
    to: { kind: "projection", segmentIndex: 2, fraction: 0.5, coordinate: [139.0025, 35] },
    ...overrides,
  };
}

function run() {
  const middle = createSplitPlan({ segments: [way()] });
  assert.deepStrictEqual(middle.summary, { sourceWays: 1, createdNodes: 2, createdWays: 2, modifiedWays: 1, modifiedRelations: 0, operationCount: 5 });
  assert.strictEqual(middle.ways[0].sections.length, 3);
  assert.deepStrictEqual(middle.ways[0].sections.map((s) => s.tactile), [false, true, false]);
  assert.strictEqual(middle.ways[0].sections[1].tags.tactile_paving, "yes");
  assert.strictEqual(middle.ways[0].sections[0].tags.tactile_paving, "no");
  assert.strictEqual(middle.ways[0].tagStrategy.kind, "independent_walkway");

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

  const relation = {
    id: 900,
    version: 4,
    tags: { type: "route", route: "foot" },
    members: [
      { type: "way", ref: 99, role: "" },
      { type: "way", ref: 100, role: "forward" },
      { type: "way", ref: 101, role: "" },
    ],
  };
  const withRelation = createSplitPlan({ segments: [way({ relations: [relation] })] });
  assert.strictEqual(withRelation.summary.modifiedRelations, 1);
  assert.strictEqual(withRelation.summary.operationCount, 6);
  const relationOperation = withRelation.operations.find((operation) => operation.elementType === "relation");
  assert.deepStrictEqual(relationOperation.after.members.map((member) => member.ref), [99, 100, "new-way-1", "new-way-2", 101]);
  assert.deepStrictEqual(relationOperation.after.members.slice(1, 4).map((member) => member.role), ["forward", "forward", "forward"]);

  const backwardRelation = { ...relation, id: 901, members: [{ type: "way", ref: 100, role: "backward" }] };
  const backward = createSplitPlan({ segments: [way({ relations: [backwardRelation] })] });
  const backwardOperation = backward.operations.find((operation) => operation.elementType === "relation");
  assert.deepStrictEqual(backwardOperation.after.members.map((member) => member.ref), ["new-way-2", "new-way-1", 100]);

  const repeatedWay = createSplitPlan({ segments: [
    way({ from: { kind: "projection", segmentIndex: 0, fraction: 0.25 }, to: { kind: "node", index: 1 } }),
    way({ from: { kind: "node", index: 2 }, to: { kind: "projection", segmentIndex: 2, fraction: 0.75 } }),
  ] });
  assert.strictEqual(repeatedWay.summary.sourceWays, 1, "the same OSM Way must be planned once");
  assert.strictEqual(repeatedWay.ways[0].ranges.length, 2, "separate traversed ranges must be preserved");
  assert.strictEqual(repeatedWay.ways[0].sections.filter((section) => section.tactile).length, 2,
    "both recorded ranges on the repeated Way must receive tactile tags");
  assert.throws(() => createSplitPlan({ segments: [way(), way({ wayVersion: 8 })] }), /inconsistent_duplicate_way/);
  assert.strictEqual(middle.osmSent, false);
  const roadway = createSplitPlan({ segments: [way({
    tags: { highway: "residential", sidewalk: "both" },
    side: "left",
  })] });
  assert.strictEqual(roadway.ways[0].tagStrategy.kind, "roadway_side");
  assert.strictEqual(roadway.ways[0].tagStrategy.side, "left");
  assert.strictEqual(roadway.ways[0].sections.find((section) => section.tactile).tags["sidewalk:left:tactile_paving"], "yes");
  assert.throws(() => createSplitPlan({ segments: [way({ tags: { highway: "residential" } })] }), /missing_side_for_roadway/);
  assert.throws(() => createSplitPlan({ segments: [way({ tags: { highway: "motorway" }, side: "right" })] }), /non_walkway_way_not_eligible/);
  assert.throws(() => createSplitPlan({ segments: [way({ tags: { highway: "residential", foot: "no" }, side: "right" })] }), /non_walkway_way_not_eligible/);
  assert.throws(() => createSplitPlan({ segments: [way({
    tags: { highway: "residential", "sidewalk:right:tactile_paving": "yes" }, side: "right",
  })] }), /tactile_tag_already_present/);
  assert.throws(() => createSplitPlan({ segments: [way({
    tags: { highway: "footway", tactile_paving: "yes" },
  })] }), /tactile_tag_already_present/, "既存の点字ブロックへ重複タグや不要な分割を作らない");
  const missingTactile = createSplitPlan({ segments: [way({
    tags: { highway: "footway" },
  })] });
  assert.strictEqual(
    missingTactile.ways[0].sections.find((section) => section.tactile).tags.tactile_paving,
    "yes",
    "タグ未設定の歩道も、OSMへ即時送信せず管理者が確認する変更候補にする"
  );
  console.log("osm_split_planner: all tests passed");
}
run();
