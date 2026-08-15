const assert = require("assert");
const { CURRENT_ROAD_TAGS } = require("../server/road_tag_policy");

assert.strictEqual(CURRENT_ROAD_TAGS.length, 23);
assert.deepStrictEqual(CURRENT_ROAD_TAGS[0], ["audible_signal", "音が鳴る信号機", 1]);
assert.ok(CURRENT_ROAD_TAGS.some((tag) => tag[0] === "tag_10" && tag[1] === "ベンチ"));
assert.ok(CURRENT_ROAD_TAGS.some((tag) => tag[0] === "tag_11" && tag[1] === "休憩"));

console.log("current StepBy road tag master is preserved for the development DB");
