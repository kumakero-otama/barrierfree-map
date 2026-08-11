const assert = require("assert");
const { chooseBestMatch, replay } = require("../server/fitting/browser_matcher");

const ways = [
  { id: 10, version: 1, priority: "road", nodes: [1, 2], coordinates: [[139, 35], [139.002, 35]] },
  { id: 20, version: 1, priority: "pedestrian", nodes: [3, 4], coordinates: [[139, 35.00005], [139.001, 35.00005]] },
  { id: 21, version: 1, priority: "pedestrian", nodes: [4, 5], coordinates: [[139.001, 35.00005], [139.002, 35.00005]] },
];

const first = chooseBestMatch({ lat: 35.00002, lng: 139.0003 }, ways, null);
assert.strictEqual(first.wayId, 20, "近接する道路より歩道を優先する");

const result = replay([
  { lat: 35.00002, lng: 139.0002 },
  { lat: 35.00002, lng: 139.0008 },
  { lat: 35.00002, lng: 139.0012 },
  { lat: 35.00002, lng: 139.0018 },
], ways);
assert.strictEqual(result.coverage, 1);
assert.strictEqual(result.connected, true);
assert.strictEqual(result.missedPedestrianPriority, 0);
assert.deepStrictEqual(result.wayIds, [20, 21]);
console.log(JSON.stringify({ result: "passed", osmSent: false, ...result, matches: undefined }));
