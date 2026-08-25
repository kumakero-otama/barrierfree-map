const test = require("node:test");
const assert = require("node:assert/strict");
const { enqueueReview, queueNotification, deliverNotification, retryFailedNotifications, isReviewAdmin } = require("../server/osm/review_queue");

test("enqueueReview creates a pending review and append-only event", async () => {
  const calls = [];
  const reviewId = "11111111-1111-4111-8111-111111111111";
  const conn = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith("SELECT review_id")) return [[{ review_id: reviewId, review_status: "pending" }]];
    return [[]];
  } };
  const result = await enqueueReview(conn, {
    recordId: "22222222-2222-4222-8222-222222222222",
    planId: "33333333-3333-4333-8333-333333333333",
    actorUserId: 9,
  });
  assert.equal(result.review_status, "pending");
  assert.equal(calls.some(c => c.sql.includes("review_events")), true);
});

test("review admin is restricted to configured Google email", async () => {
  const previous = process.env.OSM_REVIEW_ADMIN_EMAIL;
  process.env.OSM_REVIEW_ADMIN_EMAIL = "kumakero.otama@gmail.com";
  const pool = { query: async (_sql, params) => [[params[1] === "kumakero.otama@gmail.com" ? { ok: 1 } : undefined].filter(Boolean)] };
  assert.equal(await isReviewAdmin(pool, 1), true);
  if (previous === undefined) delete process.env.OSM_REVIEW_ADMIN_EMAIL; else process.env.OSM_REVIEW_ADMIN_EMAIL = previous;
});

test("missing SMTP secret records failure without throwing", async () => {
  const previousUser = process.env.SMTP_USER;
  const previousPass = process.env.SMTP_PASS;
  delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return [[]]; } };
  const queued = await queueNotification(pool, "44444444-4444-4444-8444-444444444444");
  const result = await deliverNotification(pool, { ...queued, reviewId: "44444444-4444-4444-8444-444444444444" });
  assert.deepEqual(result, { sent: false, reason: "smtp_not_configured" });
  assert.equal(calls.some(c => c.sql.includes("status='failed'")), true);
  if (previousUser !== undefined) process.env.SMTP_USER = previousUser;
  if (previousPass !== undefined) process.env.SMTP_PASS = previousPass;
});

test("notification retry is a no-op when nothing is pending", async () => {
  const pool = { query: async () => [[]] };
  assert.deepEqual(await retryFailedNotifications(pool), []);
});
