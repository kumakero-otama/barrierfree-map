#!/usr/bin/env node
// DB-only repair. No HTTP requests, OSM client, schema changes, or record updates.
const crypto = require("node:crypto");

const SINCE = "2026-11-01 00:00:00";
const ELIGIBLE = `s.started_at >= ?::timestamp
  AND s.is_active IS TRUE AND s.ended_at IS NOT NULL
  AND NOT COALESCE(u.is_guest,FALSE) AND NOT COALESCE(u.is_pro,FALSE)
  AND EXISTS (SELECT 1 FROM tactile.session_paths p WHERE p.session_id=s.session_id AND p.geom IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM tactile.session_tags st WHERE st.session_id=s.session_id)`;

async function fingerprint(conn, recordId) {
  const [rows] = await conn.query(`SELECT jsonb_build_object(
    'memo',s.memo,'endedAt',s.ended_at,'startedAt',s.started_at,'active',s.is_active,
    'userId',s.user_id,'paths',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY to_jsonb(p)::text)
      FROM tactile.session_paths p WHERE p.session_id=s.session_id),'[]'::jsonb))::text AS snapshot
    FROM tactile.sessions s WHERE s.session_id=?`, [recordId]);
  if (rows.length !== 1) throw new Error("record_snapshot_missing");
  return crypto.createHash("sha256").update(rows[0].snapshot).digest("hex");
}

async function recover(pool, { apply = false } = {}) {
  const [candidates] = await pool.query(`SELECT s.session_id FROM tactile.sessions s
    JOIN login.users u ON u.user_id=s.user_id WHERE ${ELIGIBLE}
    ORDER BY s.started_at,s.session_id`, [SINCE]);
  const summary = { mode: apply ? "apply" : "dry-run", since: SINCE,
    candidates: candidates.length, recovered: 0, skipped: 0, preservationVerified: 0,
    remaining: candidates.length, osmSent: false };
  if (!apply || candidates.length === 0) return summary;

  for (const candidate of candidates) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("SET LOCAL lock_timeout = '10s'");
      // Prevent a concurrent tag INSERT racing the no-tags recheck. Path locks also
      // protect the before/after snapshot; locks last for this one record only.
      await conn.query("LOCK TABLE tactile.session_tags IN SHARE ROW EXCLUSIVE MODE");
      await conn.query("LOCK TABLE tactile.session_paths, tactile.tags IN SHARE MODE");
      const [audit] = await conn.query(`SELECT 1 FROM pg_trigger
        WHERE tgrelid='osmchange.audit_events'::regclass
          AND tgname='osm_audit_events_append_only' AND tgenabled IN ('O','A')
          AND NOT tgisinternal AND (tgtype::int & 27)=27`);
      if (audit.length !== 1) throw new Error("append_only_audit_required");
      await conn.query(`SELECT s.session_id FROM tactile.sessions s
        JOIN login.users u ON u.user_id=s.user_id WHERE s.session_id=?
        FOR UPDATE OF s FOR SHARE OF u`, [candidate.session_id]);
      const [eligible] = await conn.query(`SELECT s.session_id FROM tactile.sessions s
        JOIN login.users u ON u.user_id=s.user_id WHERE s.session_id=? AND ${ELIGIBLE}`,
      [candidate.session_id, SINCE]);
      if (!eligible.length) {
        await conn.rollback();
        summary.skipped++;
        continue;
      }
      const [tags] = await conn.query("SELECT id FROM tactile.tags WHERE code='tactile_paving' AND is_active IS TRUE");
      if (tags.length !== 1) throw new Error("active_standard_tag_required");
      const beforeHash = await fingerprint(conn, candidate.session_id);
      // Audit and tag are atomic: either both commit or neither does.
      await conn.query(`INSERT INTO osmchange.audit_events
        (plan_id,event_type,actor_user_id,request_id,details)
        VALUES(NULL,'record_standard_tag_recovered',NULL,?,?::jsonb) RETURNING event_id`,
      [crypto.randomUUID(), JSON.stringify({ recordId: candidate.session_id,
        priorTagCount: 0, tagCode: "tactile_paving", since: SINCE,
        preservedSnapshotSha256: beforeHash, osmSent: false })]);
      const [inserted] = await conn.query(`INSERT INTO tactile.session_tags(session_id,tag_id)
        VALUES(?,?) ON CONFLICT DO NOTHING RETURNING session_id`, [candidate.session_id, tags[0].id]);
      if (inserted.affectedRows !== 1) throw new Error("standard_tag_insert_failed");
      const afterHash = await fingerprint(conn, candidate.session_id);
      if (beforeHash !== afterHash) throw new Error("record_preservation_check_failed");
      await conn.commit();
      summary.recovered++;
      summary.preservationVerified++;
    } catch (error) {
      await conn.rollback();
      // No SQL errors or underlying values are exposed in the public report.
      const failure = new Error("recovery_stopped_transaction_rolled_back");
      failure.summary = summary;
      failure.cause = error;
      throw failure;
    } finally {
      conn.release();
    }
  }
  const [remaining] = await pool.query(`SELECT count(*)::int AS count FROM tactile.sessions s
    JOIN login.users u ON u.user_id=s.user_id WHERE ${ELIGIBLE}`, [SINCE]);
  summary.remaining = remaining[0].count;
  return summary;
}

const REVIEW_ELIGIBLE = `s.started_at >= ?::timestamp AND s.is_active IS TRUE
  AND s.ended_at IS NOT NULL AND NOT COALESCE(u.is_guest,FALSE)
  AND EXISTS (SELECT 1 FROM tactile.session_paths p WHERE p.session_id=s.session_id AND p.geom IS NOT NULL)
  AND EXISTS (SELECT 1 FROM tactile.session_tags st JOIN tactile.tags t ON t.id=st.tag_id
    WHERE st.session_id=s.session_id AND t.osm_exportable IS TRUE)
  AND NOT EXISTS (SELECT 1 FROM osmchange.record_links l WHERE l.record_id=s.session_id)
  AND NOT EXISTS (SELECT 1 FROM osmchange.review_queue q WHERE q.record_id=s.session_id)`;

async function recoverReviews(pool, { apply = false, helpers } = {}) {
  const [candidates] = await pool.query(`SELECT s.session_id FROM tactile.sessions s
    JOIN login.users u ON u.user_id=s.user_id WHERE ${REVIEW_ELIGIBLE}
    ORDER BY s.started_at,s.session_id`, [SINCE]);
  const summary = { candidates: candidates.length, queued: 0, skipped: 0,
    preservationVerified: 0, notificationsDelivered: 0, osmSent: false };
  if (!apply) return summary;
  const { enqueueReview, queueNotification } = helpers || require("../server/osm/review_queue");
  for (const candidate of candidates) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("SET LOCAL lock_timeout = '10s'");
      await conn.query("LOCK TABLE tactile.session_tags IN SHARE ROW EXCLUSIVE MODE");
      await conn.query("LOCK TABLE tactile.session_paths, tactile.tags IN SHARE MODE");
      await conn.query("LOCK TABLE osmchange.record_links, osmchange.review_queue IN SHARE ROW EXCLUSIVE MODE");
      const [audit] = await conn.query(`SELECT 1 FROM pg_trigger
        WHERE tgrelid='osmchange.audit_events'::regclass
          AND tgname='osm_audit_events_append_only' AND tgenabled IN ('O','A')
          AND NOT tgisinternal AND (tgtype::int & 27)=27`);
      if (audit.length !== 1) throw new Error("append_only_audit_required");
      await conn.query(`SELECT s.session_id FROM tactile.sessions s
        JOIN login.users u ON u.user_id=s.user_id WHERE s.session_id=?
        FOR UPDATE OF s FOR SHARE OF u`, [candidate.session_id]);
      const [eligible] = await conn.query(`SELECT s.session_id,s.user_id,s.started_at
        FROM tactile.sessions s JOIN login.users u ON u.user_id=s.user_id
        WHERE s.session_id=? AND ${REVIEW_ELIGIBLE}`, [candidate.session_id, SINCE]);
      if (!eligible.length) {
        await conn.rollback();
        summary.skipped++;
        continue;
      }
      const row = eligible[0];
      const beforeHash = await fingerprint(conn, row.session_id);
      const [beforeTags] = await conn.query("SELECT tag_id FROM tactile.session_tags WHERE session_id=? ORDER BY tag_id", [row.session_id]);
      const planId = crypto.randomUUID();
      const context = { recordId: row.session_id, recoveryNeedsRefit: true, osmWriteRequested: false };
      await conn.query(`INSERT INTO osmchange.change_plans
        (plan_id,operation_type,created_by,summary,elements,client_context)
        VALUES(?,'merge',?,?,'[]'::jsonb,?::jsonb) RETURNING plan_id`,
      [planId, row.user_id, "保存復旧・公開前に再マップマッチング", JSON.stringify(context)]);
      await conn.query(`INSERT INTO osmchange.record_links(record_id,created_by,merge_plan_id,osm_status)
        VALUES(?,?,?,'draft') RETURNING record_id`, [row.session_id, row.user_id, planId]);
      const review = await enqueueReview(conn, { recordId: row.session_id, planId,
        actorUserId: row.user_id, sourceType: "new_record" });
      await conn.query(`UPDATE osmchange.review_queue SET source_metadata=?::jsonb WHERE review_id=?`,
      [JSON.stringify({ recoveryNeedsRefit: true, classification: "保存復旧・公開前に再マップマッチング",
        startedAt: row.started_at }), review.review_id]);
      await queueNotification(conn, review.review_id);
      await conn.query(`INSERT INTO osmchange.audit_events(plan_id,event_type,actor_user_id,request_id,details)
        VALUES(?,'record_saved_review_recovered',NULL,?,?::jsonb) RETURNING event_id`,
      [planId, crypto.randomUUID(), JSON.stringify({ ...context, reviewId: review.review_id,
        preservedSnapshotSha256: beforeHash, notificationQueued: true, osmSent: false })]);
      const [afterTags] = await conn.query("SELECT tag_id FROM tactile.session_tags WHERE session_id=? ORDER BY tag_id", [row.session_id]);
      if (beforeHash !== await fingerprint(conn, row.session_id)
        || JSON.stringify(beforeTags) !== JSON.stringify(afterTags)) throw new Error("record_preservation_check_failed");
      await conn.commit();
      summary.queued++;
      summary.preservationVerified++;
    } catch (error) {
      await conn.rollback();
      const failure = new Error("review_recovery_stopped_transaction_rolled_back");
      failure.summary = summary;
      failure.cause = error;
      throw failure;
    } finally {
      conn.release();
    }
  }
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node tools/recover_saved_record_tags.js [--apply] [--queue-reviews]\nDefault: read-only dry-run. DB_CONFIG_PATH selects the DB config. --apply --queue-reviews also creates local refit-required drafts, reviews and unsent notifications. Dry-run review counts exclude records whose missing tags would first be repaired. No OSM writes.");
    return;
  }
  if (args.some((arg) => !["--apply", "--queue-reviews"].includes(arg))) throw new Error("unknown_argument");
  const { createDbPool } = require("../server/db");
  const { pool, error } = createDbPool();
  if (!pool) throw new Error("database_unavailable", { cause: error });
  try {
    const report = await recover(pool, { apply: args.includes("--apply") });
    if (args.includes("--queue-reviews")) {
      report.reviews = await recoverReviews(pool, { apply: args.includes("--apply") });
      if (!args.includes("--apply")) report.reviews.pendingTagRecoveryMayIncreaseCandidates = report.candidates > 0;
    }
    console.log(JSON.stringify(report));
  } finally {
    await pool.pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, ...(error.summary ? { summary: error.summary } : {}) }));
  process.exitCode = 1;
});
module.exports = { recover, recoverReviews, fingerprint, SINCE };
