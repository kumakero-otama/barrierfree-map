const assert = require("assert");
const { buildQuery, normalizeWays } = require("../server/api/osm_walkable");

const query = buildQuery(35, 139, 1000);
assert.match(query, /relation\(bw\.walkable\)/);

const ways = normalizeWays({ elements: [
  {
    type: "way", id: 100, version: 7, nodes: [10, 11],
    geometry: [{ lat: 35, lon: 139 }, { lat: 35, lon: 139.001 }],
    tags: { highway: "footway" },
  },
  {
    type: "relation", id: 900, version: 4,
    members: [{ type: "way", ref: 100, role: "forward" }],
    tags: { type: "route", route: "foot" },
  },
] });

assert.strictEqual(ways.length, 1);
assert.strictEqual(ways[0].relations.length, 1);
assert.strictEqual(ways[0].relations[0].id, 900);
assert.deepStrictEqual(ways[0].relations[0].members[0], { type: "way", ref: 100, role: "forward" });
console.log("osm_walkable_relations: mocked relation normalization passed; no OSM network used");
