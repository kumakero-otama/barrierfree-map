const assert = require("assert");
const { PUBLIC_TAG_CODES, SYSTEM_TAGS, getRecordPublication } = require("../server/pro_record_policy");

assert.deepStrictEqual([...PUBLIC_TAG_CODES], ["tactile_paving", "tactile_paving_jis", "tactile_paving_non_jis"]);
assert.strictEqual(SYSTEM_TAGS.filter((tag) => tag[2]).length, 3);
assert.ok(SYSTEM_TAGS.filter((tag) => !tag[2]).every((tag) => tag[3] === "red"));

const pool = {
  async query(sql) {
    if (/SELECT s\.session_id/.test(sql)) return [[{
      session_id: "record-1", is_pro: true, has_public_tag: false,
      has_private_tag: true, tag_codes: ["fence"],
    }]];
    return [[]];
  },
};

(async () => {
  const publication = await getRecordPublication(pool, "record-1", 1);
  assert.strictEqual(publication.osmEligible, false);
  assert.strictEqual(publication.hasPrivateTag, true);
  console.log("pro record policy tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
