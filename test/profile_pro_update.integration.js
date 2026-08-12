const assert = require("assert");
const { createDbPool } = require("../server/db");
const BASE_URL = process.env.TEST_API_URL || "http://127.0.0.1:3100";
const consent = { terms_accepted: true, privacy_accepted: true, terms_version: "2026-08-03", privacy_version: "2026-08-03" };

(async () => {
  const guestResponse = await fetch(`${BASE_URL}/auth/guest`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(consent),
  });
  const guest = await guestResponse.json();
  assert.strictEqual(guestResponse.status, 200);
  const { pool } = createDbPool();
  await pool.query("UPDATE login.users SET is_guest=FALSE WHERE user_id=?", [guest.user.userId]);
  const headers = { Authorization: `Bearer ${guest.access_token}`, "Content-Type": "application/json" };
  const profile = await fetch(`${BASE_URL}/auth/profile`, {
    method: "POST", headers, body: JSON.stringify({ username: "profile-pro-test" }), signal: AbortSignal.timeout(5000),
  });
  assert.strictEqual(profile.status, 200, await profile.text());
  const pro = await fetch(`${BASE_URL}/api/pro-status`, {
    method: "PUT", headers, body: JSON.stringify({ isPro: true }), signal: AbortSignal.timeout(5000),
  });
  const proBody = await pro.json();
  assert.strictEqual(pro.status, 200);
  assert.strictEqual(proBody.isPro, true);
  await pool.query("UPDATE login.users SET is_active=FALSE WHERE user_id=?", [guest.user.userId]);
  console.log("profile + PRO update completed without request-body timeout");
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
