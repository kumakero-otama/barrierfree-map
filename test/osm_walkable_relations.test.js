const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { buildQuery, normalizeWays, normalizeOsmXml, clearWalkableNetworkCache } = require("../server/api/osm_walkable");
const source = fs.readFileSync(path.join(__dirname, "../server/api/osm_walkable.js"), "utf8");

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
const fallbackWays = normalizeWays(normalizeOsmXml(`<?xml version="1.0"?><osm>
  <node id="1" lat="35" lon="139"/><node id="2" lat="35.001" lon="139.001"/>
  <way id="200" version="3"><nd ref="1"/><nd ref="2"/><tag k="highway" v="footway"/></way>
  <way id="201" version="1"><nd ref="1"/><nd ref="2"/><tag k="highway" v="construction"/></way>
  <relation id="901" version="5"><member type="way" ref="200" role="forward"/><tag k="type" v="route"/><tag k="route" v="foot"/></relation>
</osm>`));
assert.strictEqual(fallbackWays.length, 1);
assert.strictEqual(fallbackWays[0].id, 200);
assert.strictEqual(fallbackWays[0].version, 3);
assert.deepStrictEqual(fallbackWays[0].nodes, [1, 2]);
assert.strictEqual(fallbackWays[0].relations[0].id, 901);
assert.strictEqual(fallbackWays[0].relations[0].version, 5);
assert.strictEqual(typeof clearWalkableNetworkCache, "function",
  "successful OSM writes must be able to invalidate the server read cache");
assert.match(source, /const forceRefresh = url\.searchParams\.get\("forceRefresh"\) === "1"/);
assert.match(source, /if \(!forceRefresh && cached/,
  "record finalization must be able to bypass the server-side network cache");
assert.match(source, /if \(options\.preferOfficial\)[\s\S]*fetchOsmMap/,
  "OSM publishing must be able to prefer the current official OSM map response");
assert.match(source, /fetchOverpassFirstSuccessful\(hosts/,
  "approval fallback must not wait for unavailable Overpass hosts one by one");
console.log("osm_walkable_relations: mocked relation normalization passed; no OSM network used");
