const assert = require("assert");
const { createDbPool } = require("../server/db");

const BASE_URL = process.env.TEST_API_URL || "http://127.0.0.1:3100";

async function post(body) {
  const response = await fetch(`${BASE_URL}/auth/google/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function postGuest(body) {
  const response = await fetch(`${BASE_URL}/auth/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function run() {
  const { pool, error } = createDbPool();
  if (error) throw error;
  const [beforeRows] = await pool.query("SELECT COUNT(*)::int AS count FROM login.users");
  const common = {
    id_token: "synthetic.invalid.token",
    username: "consent-test",
    icon_data_url: "data:image/png;base64,aA==",
  };

  const missing = await post(common);
  assert.strictEqual(missing.status, 400);
  assert.strictEqual(missing.body.error, "consent_required");

  const wrongVersion = await post({
    ...common,
    terms_accepted: true,
    privacy_accepted: true,
    terms_version: "old",
    privacy_version: "old",
  });
  assert.strictEqual(wrongVersion.status, 400);
  assert.strictEqual(wrongVersion.body.error, "invalid_consent_version");

  const missingGuest = await postGuest({});
  assert.strictEqual(missingGuest.status, 400);
  assert.strictEqual(missingGuest.body.error, "consent_required");

  const wrongGuestVersion = await postGuest({
    terms_accepted: true,
    privacy_accepted: true,
    terms_version: "old",
    privacy_version: "old",
  });
  assert.strictEqual(wrongGuestVersion.status, 400);
  assert.strictEqual(wrongGuestVersion.body.error, "invalid_consent_version");

  const [afterRows] = await pool.query("SELECT COUNT(*)::int AS count FROM login.users");
  assert.strictEqual(afterRows[0].count, beforeRows[0].count);
  console.log("signup_consent: Google/guest missing or outdated consent rejected; no account created");
  process.exit(0);
}

run().catch((error) => { console.error(error); process.exit(1); });
