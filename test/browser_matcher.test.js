const assert = require("assert");
const { chooseBestMatch, preparePoints, replay } = require("../server/fitting/browser_matcher");

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

const smoothed = replay([
  { lat: 35.00001, lng: 139.0001, accuracy: 5 },
  { lat: 35, lng: 139.0011, accuracy: 5 },
  { lat: 35, lng: 139.0015, accuracy: 5 },
], [
  { id: 30, version: 1, priority: "pedestrian", nodes: [30, 31], coordinates: [[139, 35.00001], [139.0003, 35.00001]] },
  { id: 31, version: 1, priority: "road", nodes: [40, 41], coordinates: [[139, 35], [139.002, 35]] },
]);
assert.strictEqual(smoothed.routeSmoothed, true);
assert.strictEqual(smoothed.connected, true);
assert.deepStrictEqual(smoothed.wayIds, [31]);

const bridged = replay([
  { lat: 35, lng: 139.0002, accuracy: 5 },
  { lat: 35, lng: 139.0028, accuracy: 5 },
], [
  { id: 40, version: 1, priority: "pedestrian", nodes: [1, 2], coordinates: [[139, 35], [139.001, 35]] },
  { id: 41, version: 1, priority: "pedestrian", nodes: [2, 3], coordinates: [[139.001, 35], [139.002, 35.0005]] },
  { id: 42, version: 1, priority: "pedestrian", nodes: [3, 4], coordinates: [[139.002, 35.0005], [139.003, 35]] },
]);
assert.strictEqual(bridged.routeConfirmed, true);
assert.deepStrictEqual(bridged.observedWayIds, [40, 42]);
assert.deepStrictEqual(bridged.wayIds, [40, 41, 42]);
assert.deepStrictEqual(bridged.connectorWayIds, [41]);

const unconnected = replay([
  { lat: 35, lng: 139.0001, accuracy: 5 },
  { lat: 35, lng: 139.0101, accuracy: 5 },
], [
  { id: 50, version: 1, priority: "pedestrian", nodes: [10, 11], coordinates: [[139, 35], [139.001, 35]] },
  { id: 51, version: 1, priority: "pedestrian", nodes: [20, 21], coordinates: [[139.01, 35], [139.011, 35]] },
]);
assert.strictEqual(unconnected.routeConfirmed, false, "全体を連続経路にできなければ確定しない");
assert.deepStrictEqual(unconnected.wayIds.length, 1);

const prepared = preparePoints([
  { lat: 35, lng: 139, accuracy: 5 },
  { lat: 36, lng: 140, accuracy: 80 },
  { lat: 35, lng: 139.002, accuracy: 6 },
  { lat: 36, lng: 140, accuracy: 90 },
]);
assert.strictEqual(prepared[1].quality, "interpolated");
assert.ok(Math.abs(prepared[1].lat - 35) < 1e-9);
assert.ok(Math.abs(prepared[1].lng - 139.001) < 1e-9);
assert.strictEqual(prepared[3].quality, "discarded");

const manyWays = Array.from({ length: 500 }, (_, index) => ({ id: index + 1000, version: 1, priority: index === 0 ? "pedestrian" : "road",
  nodes: [index * 2 + 100, index * 2 + 101], coordinates: [[139, 35 + index * .0002], [139.01, 35 + index * .0002]] }));
const manyPoints = Array.from({ length: 1000 }, (_, index) => ({ lat: 35.00001, lng: 139 + index * .000009, accuracy: 5 }));
const performance = replay(manyPoints, manyWays);
assert.strictEqual(performance.coverage, 1);
assert.ok(performance.durationMs <= 5000, `1000点の処理が遅すぎます: ${performance.durationMs}ms`);
console.log(JSON.stringify({ result: "passed", osmSent: false, ...result, matches: undefined,
  benchmark: { points: manyPoints.length, ways: manyWays.length, durationMs: performance.durationMs } }));
