const assert = require("assert");
const { buildChangesetXml, buildOsmChangeXml, parseDiffResult, createOsmApiClient } = require("../server/osm/osm_api_client");
const { executeWithClient } = require("../server/osm/osm_executor");

async function run() {
  const operations = [
    { elementType: "node", action: "create", osmId: null, version: null, before: null, after: { temporaryId: "new-node-1", lat: 35, lng: 139, tags: {} } },
    { elementType: "way", action: "modify", osmId: 100, version: 7, before: { nodes: [10, 11], tags: { highway: "footway" } }, after: { nodes: [10, "new-node-1"], tags: { highway: "footway" } } },
    { elementType: "way", action: "create", osmId: null, version: null, before: null, after: { temporaryId: "new-way-1", nodes: ["new-node-1", 11], tags: { highway: "footway", tactile_paving: "yes" } } },
    { elementType: "relation", action: "modify", osmId: 900, version: 4,
      before: { members: [{ type: "way", ref: 100, role: "forward" }], tags: { type: "route" } },
      after: { members: [{ type: "way", ref: 100, role: "forward" }, { type: "way", ref: "new-way-1", role: "forward" }], tags: { type: "route" } } },
  ];
  const built = buildOsmChangeXml(operations, 555);
  assert.strictEqual(built.temporaryIds["new-node-1"], -1);
  assert.strictEqual(built.temporaryIds["new-way-1"], -2);
  assert.match(built.xml, /<node id="-1" changeset="555"/);
  assert.match(built.xml, /<way id="100" changeset="555" version="7">/);
  assert.match(built.xml, /<nd ref="-1"\/>/);
  assert.match(built.xml, /<relation id="900" changeset="555" version="4">/);
  assert.match(built.xml, /<member type="way" ref="-2" role="forward"\/>/);
  assert.match(buildChangesetXml({ comment: "A&B" }), /A&amp;B/);
  assert.deepStrictEqual(parseDiffResult('<diffResult><node old_id="-1" new_id="900" new_version="1"/><way old_id="100" new_id="100" new_version="8"/></diffResult>'), [
    { elementType: "node", oldId: -1, newId: 900, newVersion: 1 },
    { elementType: "way", oldId: 100, newId: 100, newVersion: 8 },
  ]);

  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/way/100")) return { ok: true, text: async () => '<osm><way id="100" version="7"/></osm>' };
    if (url.endsWith("/relation/900")) return { ok: true, text: async () => '<osm><relation id="900" version="4"/></osm>' };
    if (url.endsWith("/changeset/create")) return { ok: true, text: async () => "555" };
    if (url.endsWith("/upload")) return { ok: true, text: async () => '<diffResult><node old_id="-1" new_id="900" new_version="1"/></diffResult>' };
    if (url.endsWith("/close")) return { ok: true, text: async () => "" };
    throw new Error("unexpected_fake_url");
  };
  const fakeClient = createOsmApiClient({ baseUrl: "https://invalid.test", accessToken: "fake", fetchImpl: fakeFetch });
  let observedChangesetId = null;
  const result = await executeWithClient({
    client: fakeClient, operations, summary: "test", planId: "plan-1", operationType: "merge",
    onChangesetCreated: async (changesetId) => { observedChangesetId = changesetId; },
  });
  assert.strictEqual(result.changesetId, 555);
  assert.strictEqual(observedChangesetId, 555);
  assert.strictEqual(result.diffResult[0].newId, 900);
  assert.strictEqual(calls.length, 5);
  assert.ok(calls.every((call) => call.url.startsWith("https://invalid.test/")));

  const conflictClient = createOsmApiClient({
    baseUrl: "https://invalid.test",
    accessToken: "fake",
    fetchImpl: async () => ({ ok: true, text: async () => '<osm><way id="100" version="8"/></osm>' }),
  });
  await assert.rejects(
    executeWithClient({ client: conflictClient, operations, summary: "test", planId: "plan-1", operationType: "merge" }),
    /osm_version_conflict/
  );
  console.log("osm_api_client: mocked tests passed; no OSM network used");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
