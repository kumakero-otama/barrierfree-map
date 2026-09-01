"use strict";

// 安全条件の変更前に確認キューへ入らなかった記録を、保存済みWayスナップショットから復旧する。
// --apply を付けない限りDBを書き換えず、OSM APIには一切接続しない。
const crypto = require("crypto");
const { createDbPool } = require("../server/db");
const { createSplitPlan } = require("../server/osm/split_planner");
const { ensureReviewSchema, enqueueReview } = require("../server/osm/review_queue");

function parseArguments(argv) {
  const recordIds = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--record-id" && argv[index + 1]) recordIds.push(argv[++index]);
  }
  return { apply: argv.includes("--apply"), recordIds: [...new Set(recordIds)] };
}

async function loadRecord(pool, recordId) {
  const [sessions] = await pool.query(
    `SELECT s.session_id,s.user_id,COALESCE(u.is_guest,FALSE) is_guest
       FROM tactile.sessions s JOIN login.users u ON u.user_id=s.user_id
      WHERE s.session_id=? LIMIT 1`, [recordId]
  );
  if (!sessions[0]) throw new Error("record_not_found");
  if (sessions[0].is_guest) throw new Error("guest_record_not_eligible");
  const [links] = await pool.query("SELECT merge_plan_id FROM osmchange.record_links WHERE record_id=? LIMIT 1", [recordId]);
  if (links[0]) return { skipped: true, reason: "already_linked" };
  const [snapshots] = await pool.query(
    `SELECT way_id,way_version,node_ids,full_coordinates,segment_from,segment_to,
            original_tags,relation_context,tactile_side
       FROM tactile.way_snapshots WHERE record_id=? ORDER BY segment_order`, [recordId]
  );
  if (!snapshots.length) throw new Error("way_snapshots_missing");
  return {
    session: sessions[0],
    segments: snapshots.map((row) => ({
      wayId: Number(row.way_id), wayVersion: Number(row.way_version),
      nodes: row.node_ids, fullCoordinates: row.full_coordinates,
      from: row.segment_from, to: row.segment_to, tags: row.original_tags,
      relations: row.relation_context || [], side: row.tactile_side || null,
    })),
  };
}

async function requeue(pool, recordId, apply) {
  const record = await loadRecord(pool, recordId);
  if (record.skipped) return { recordId, ...record };
  const splitPlan = createSplitPlan({ segments: record.segments }, { tactileValue: "yes" });
  if (!apply) return { recordId, dryRun: true, operationCount: splitPlan.summary.operationCount };

  const planId = crypto.randomUUID();
  const context = {
    previewOnly: false, osmWriteRequested: false, reviewRequired: true,
    planner: "split_planner_v2_relations", recordId,
    recovery: "requeued_after_untagged_tactile_policy_update",
    splitSummary: splitPlan.summary,
  };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO osmchange.change_plans(plan_id,operation_type,created_by,source_plan_id,summary,elements,client_context)
       VALUES(?,'merge',?,NULL,?,?::jsonb,?::jsonb) RETURNING plan_id`,
      [planId, record.session.user_id, "StepByによる点字ブロック記録", JSON.stringify(splitPlan.operations), JSON.stringify(context)]
    );
    await conn.query(
      `INSERT INTO osmchange.record_links(record_id,created_by,merge_plan_id,osm_status)
       VALUES(?,?,?,'draft') RETURNING record_id`, [recordId, record.session.user_id, planId]
    );
    await conn.query(
      `INSERT INTO osmchange.audit_events(plan_id,event_type,actor_user_id,request_id,details)
       VALUES(?,'split_plan_backfilled_after_policy_update',?,NULL,?::jsonb) RETURNING event_id`,
      [planId, record.session.user_id, JSON.stringify({ recordId, osmSent: false, ...splitPlan.summary })]
    );
    const review = await enqueueReview(conn, {
      recordId, planId, actorUserId: record.session.user_id, sourceType: "new_record",
    });
    await conn.commit();
    return { recordId, reviewId: review.review_id, planId, queued: true, osmSent: false };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.recordIds.length) throw new Error("record_id_required");
  const { pool, error } = createDbPool();
  if (error || !pool) throw error || new Error("database_unavailable");
  await ensureReviewSchema(pool);
  const results = [];
  for (const recordId of options.recordIds) {
    try {
      results.push(await requeue(pool, recordId, options.apply));
    } catch (errorItem) {
      results.push({ recordId, error: String(errorItem.message || errorItem), osmSent: false });
    }
  }
  console.log(JSON.stringify({ apply: options.apply, results }, null, 2));
  if (pool.pool && typeof pool.pool.end === "function") await pool.pool.end();
  if (results.some((item) => item.error)) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

module.exports = { parseArguments };
