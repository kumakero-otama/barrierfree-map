const assert = require("assert");
const { matchesRule } = require("../server/osm/opt_out");

const operation = {
  elementType: "way", osmId: 100,
  before: { tags: { highway: "footway", tactile_paving: "no" }, coordinates: [[139, 35], [139.001, 35.001]] },
  after: { tags: { highway: "footway", tactile_paving: "yes" }, coordinates: [[139, 35], [139.001, 35.001]] },
};
assert.strictEqual(matchesRule({ rule_type: "way", rule_value: { wayId: 100 } }, operation, null), true);
assert.strictEqual(matchesRule({ rule_type: "osm_user", rule_value: { osmUserId: 55 } }, operation, { userId: 55 }), true);
assert.strictEqual(matchesRule({ rule_type: "tag", rule_value: { key: "highway", value: "footway" } }, operation, null), true);
assert.strictEqual(matchesRule({ rule_type: "region", rule_value: { bbox: [138.9, 34.9, 139.1, 35.1] } }, operation, null), true);
assert.strictEqual(matchesRule({ rule_type: "region", rule_value: { bbox: [0, 0, 1, 1] } }, operation, null), false);
console.log("OSM opt-out rules cover Way, mapper, tag and region without network access");
