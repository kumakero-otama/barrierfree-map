const crypto = require("crypto");
const nodemailer = require("nodemailer");

const REVIEW_STATES = new Set(["pending", "approved", "rejected", "merge_failed", "merged"]);

async function ensureReviewSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS osmchange.review_queue (
    review_id UUID PRIMARY KEY,
    record_id UUID NOT NULL UNIQUE,
    plan_id UUID NOT NULL UNIQUE,
    source_type TEXT NOT NULL CHECK(source_type IN ('new_record','legacy_record')),
    source_record_id TEXT,
    review_status TEXT NOT NULL DEFAULT 'pending'
      CHECK(review_status IN ('pending','approved','rejected','merge_failed','merged')),
    rejection_reason TEXT,
    reviewer_user_id BIGINT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS osmchange.review_events (
    event_id BIGSERIAL PRIMARY KEY,
    review_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    actor_user_id BIGINT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS osmchange.review_notifications (
    notification_id UUID PRIMARY KEY,
    review_id UUID NOT NULL,
    recipient TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','sent','failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query("CREATE INDEX IF NOT EXISTS osm_review_status_idx ON osmchange.review_queue(review_status,created_at DESC)");
  await pool.query(`CREATE OR REPLACE FUNCTION osmchange.prevent_review_history_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'OSM review history is append-only'; END $$`);
  await pool.query("DROP TRIGGER IF EXISTS osm_review_events_append_only ON osmchange.review_events");
  await pool.query(`CREATE TRIGGER osm_review_events_append_only BEFORE UPDATE OR DELETE ON osmchange.review_events
    FOR EACH ROW EXECUTE FUNCTION osmchange.prevent_review_history_mutation()`);
}

async function enqueueReview(conn, { recordId, planId, actorUserId, sourceType = "new_record", sourceRecordId = null }) {
  const reviewId = crypto.randomUUID();
  await conn.query(`INSERT INTO osmchange.review_queue
    (review_id,record_id,plan_id,source_type,source_record_id)
    VALUES(?,?,?,?,?) ON CONFLICT(record_id) DO NOTHING`,
  [reviewId, recordId, planId, sourceType, sourceRecordId]);
  const [rows] = await conn.query("SELECT review_id,review_status FROM osmchange.review_queue WHERE record_id=? LIMIT 1", [recordId]);
  const review = rows[0];
  if (!review) throw new Error("review_enqueue_failed");
  await conn.query(`INSERT INTO osmchange.review_events(review_id,event_type,actor_user_id,details)
    VALUES(?,'queued',?,?::jsonb)`, [review.review_id, actorUserId, JSON.stringify({ recordId, planId, sourceType })]);
  return review;
}

async function queueNotification(pool, reviewId) {
  const recipient = String(process.env.OSM_REVIEW_ADMIN_EMAIL || "kumakero.otama@gmail.com").trim().toLowerCase();
  const notificationId = crypto.randomUUID();
  await pool.query(`INSERT INTO osmchange.review_notifications(notification_id,review_id,recipient,status)
    VALUES(?,?,?,'pending')`, [notificationId, reviewId, recipient]);
  return { notificationId, recipient };
}

async function deliverNotification(pool, { notificationId, reviewId, recipient }) {
  const host = String(process.env.SMTP_HOST || "smtp.gmail.com");
  const user = String(process.env.SMTP_USER || "");
  const pass = String(process.env.SMTP_PASS || "");
  const reviewBaseUrl = String(process.env.OSM_REVIEW_URL || "https://stepby-api-8-229-191-182.sslip.io/admin/osm-review.html");
  if (!user || !pass) {
    await pool.query(`UPDATE osmchange.review_notifications SET status='failed',attempt_count=attempt_count+1,
      last_error='smtp_not_configured',updated_at=NOW() WHERE notification_id=?`, [notificationId]);
    return { sent: false, reason: "smtp_not_configured" };
  }
  try {
    const transport = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || "true") !== "false",
      auth: { user, pass },
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM || user,
      to: recipient,
      subject: "[StepBy] 点字ブロック記録の確認待ち",
      text: `点字ブロック記録が確認待ちになりました。\n記録ID: ${reviewId}\n確認画面: ${reviewBaseUrl}`,
    });
    await pool.query(`UPDATE osmchange.review_notifications SET status='sent',attempt_count=attempt_count+1,
      last_error=NULL,sent_at=NOW(),updated_at=NOW() WHERE notification_id=?`, [notificationId]);
    return { sent: true };
  } catch (error) {
    await pool.query(`UPDATE osmchange.review_notifications SET status='failed',attempt_count=attempt_count+1,
      last_error=?,updated_at=NOW() WHERE notification_id=?`, [String(error.message || error).slice(0, 500), notificationId]);
    return { sent: false, reason: "smtp_send_failed" };
  }
}

async function isReviewAdmin(pool, userId) {
  const allowed = String(process.env.OSM_REVIEW_ADMIN_EMAIL || "kumakero.otama@gmail.com").trim().toLowerCase();
  const [rows] = await pool.query(`SELECT 1 FROM login.user_auth_providers
    WHERE user_id=? AND provider='google' AND LOWER(email)=? LIMIT 1`, [userId, allowed]);
  return Boolean(rows[0]);
}

module.exports = { REVIEW_STATES, ensureReviewSchema, enqueueReview, queueNotification, deliverNotification, isReviewAdmin };
