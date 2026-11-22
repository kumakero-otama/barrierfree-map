const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const text = fs.readFileSync(path.join(__dirname, "../server/api/osm_changes.js"), "utf8");
const start = text.indexOf("async function executeUserPlan(");
const end = text.indexOf("    const gate = await writeGate();", start);
const events = [];
const ctx = { appendAudit: async (...args) => events.push(args) };
vm.createContext(ctx);
vm.runInContext(text.slice(start, end) + "}", ctx);
(async () => {
  await assert.rejects(ctx.executeUserPlan({}, {plan_id: "p", elements: [], client_context: {}}, "execute"), /record_requires_refit/);
  await assert.rejects(ctx.executeUserPlan({}, {plan_id: "p", elements: [{}], client_context: {recoveryNeedsRefit: true}}, "execute"), /record_requires_refit/);
  assert.equal(events.length, 2);
  assert(text.includes("freshReview.source_metadata?.recoveryNeedsRefit"));
  assert(text.includes("recoveryNeedsRefit: false"));
  console.log("Recovered plans cannot create OSM clients or write before refitting; blocked attempts are audited");
})().catch(error => { console.error(error); process.exitCode = 1; });
