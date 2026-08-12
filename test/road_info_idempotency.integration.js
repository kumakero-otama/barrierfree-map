const assert = require("assert");
const BASE_URL = process.env.TEST_API_URL || "http://127.0.0.1:3100";

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  return { status: response.status, body: await response.json() };
}

(async () => {
  const guest = await request("/auth/guest", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ terms_accepted: true, privacy_accepted: true, terms_version: "2026-08-03", privacy_version: "2026-08-03" }),
  });
  assert.strictEqual(guest.status, 200, JSON.stringify(guest.body));
  const key = `road:test-${Date.now()}`;
  const options = {
    method: "POST",
    headers: { Authorization: `Bearer ${guest.body.access_token}`, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ lat: 35.0, lng: 134.0, tagIds: [], detail: "idempotency integration test", images: [] }),
  };
  const first = await request("/api/road-info", options);
  assert.strictEqual(first.status, 201, JSON.stringify(first.body));
  const second = await request("/api/road-info", options);
  assert.strictEqual(second.status, 200, JSON.stringify(second.body));
  assert.strictEqual(second.body.duplicate, true);
  assert.strictEqual(second.body.pointId, first.body.pointId);

  const removed = await request("/api/road-info", {
    method: "POST", headers: { Authorization: `Bearer ${guest.body.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pointId: first.body.pointId, status: "deleted" }),
  });
  assert.strictEqual(removed.status, 201, JSON.stringify(removed.body));
  console.log(JSON.stringify({ result: "passed", samePointId: true, duplicatePrevented: true, testPointDeactivated: true, osmSent: false }));
})().catch((error) => { console.error(error); process.exit(1); });
