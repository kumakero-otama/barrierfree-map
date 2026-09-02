const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createLegacyReviewPlan, boundaryPosition } = require("../server/osm/legacy_review_planner");
const changesSource = fs.readFileSync(path.join(__dirname, "../server/api/osm_changes.js"), "utf8");

const footway = {
  id: 1001,
  version: 7,
  nodes: [11, 12, 13],
  coordinates: [[134.0, 34.0], [134.0005, 34.0], [134.001, 34.0]],
  tags: { highway: "footway", tactile_paving: "no" },
  relations: [],
  priority: "pedestrian",
};
const metadata = {
  pathGeoJson: JSON.stringify({
    type: "LineString",
    coordinates: [[134.0001, 34.0], [134.0009, 34.0]],
  }),
  rawPoints: [
    { lat: 34.0, lng: 134.0001, accuracy: null },
    { lat: 34.0, lng: 134.0005, accuracy: null },
    { lat: 34.0, lng: 134.0009, accuracy: null },
  ],
};

const result = createLegacyReviewPlan(metadata, [footway]);
assert.equal(result.fitting.routeConfirmed, true);
assert.deepEqual(result.fitting.wayIds, [1001]);
assert.equal(result.segments.length, 1);
assert.equal(result.segments[0].side, null);
assert.ok(result.splitPlan.operations.length >= 3);
assert.ok(result.splitPlan.operations.some((operation) => operation.after?.tags?.tactile_paving === "yes"));

const untaggedResult = createLegacyReviewPlan(metadata, [{ ...footway, tags: { highway: "footway" } }]);
assert.ok(untaggedResult.splitPlan.operations.some((operation) => operation.after?.tags?.tactile_paving === "yes"));

const roadway = {
  ...footway,
  id: 2001,
  tags: { highway: "residential" },
  priority: "road",
};
const roadResult = createLegacyReviewPlan({
  ...metadata,
  pathGeoJson: JSON.stringify({ type: "LineString", coordinates: [[134.0001, 34.00002], [134.0009, 34.00002]] }),
  rawPoints: metadata.rawPoints.map((point) => ({ ...point, lat: 34.00002 })),
}, [roadway]);
assert.ok(["left", "right"].includes(roadResult.segments[0].side));
assert.ok(roadResult.splitPlan.operations.some((operation) => Object.keys(operation.after?.tags || {})
  .some((key) => key.startsWith("sidewalk:") && key.endsWith(":tactile_paving"))));

assert.throws(() => createLegacyReviewPlan({ rawPoints: [{ lat: 34, lng: 134 }] }, [footway]), /legacy_points_not_available/);
assert.match(changesSource, /preliminary\.fitting\.wayIds\.map\(fetchOfficialWay\)/,
  "legacy publishing must refresh every selected Way from the official OSM API before planning");
assert.match(changesSource, /createLegacyReviewPlan\(metadata, refreshedWays\)/);
assert.match(changesSource, /\["legacy_record", "new_record"\]\.includes\(freshReview\.source_type\)/,
  "every approval retry must rebuild its plan from current OSM data");
assert.match(changesSource, /prepareNewRecordReviewPlan\(req, freshReview\)/,
  "new records must be rebuilt from persisted raw GPS before publication");
assert.match(changesSource, /official_review_way_fallback/,
  "review approval must use current official Way data when the nearby Overpass read is unavailable");
assert.match(changesSource, /Promise\.allSettled\(\[\.\.\.ids\]\.map\(fetchOfficialWay\)\)/,
  "the fallback must refresh stored Way IDs through the official OSM API");
assert.equal(boundaryPosition({ kind: "node", index: 2 }), 2);
assert.equal(boundaryPosition({ kind: "projection", segmentIndex: 1, fraction: 0.25 }), 1.25);

console.log("osm_legacy_review_planner.test.js: OK");
