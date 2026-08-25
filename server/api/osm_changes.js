const crypto = require("crypto");
const { getRecordPublication } = require("../pro_record_policy");
const { createDbPool } = require("../db");
const { createSplitPlan } = require("../osm/split_planner");
const { executeWithClient } = require("../osm/osm_executor");
const { clearWalkableNetworkCache } = require("./osm_walkable");
const { createExecutableRevert } = require("../osm/revert_planner");
const { ensureRecordLinkSchema } = require("../osm/record_links");
const { createServiceAccountOsmClient, resolvedServiceAccountConfig } = require("../osm/service_account_client");
const { ensureOptOutSchema, findOptOutMatch } = require("../osm/opt_out");
const { ensureReviewSchema, enqueueReview, queueNotification, deliverNotification, retryFailedNotifications, isReviewAdmin } = require("../osm/review_queue");

const MAX_BODY_BYTES = 1024 * 1024;
const OPERATION_TYPES = new Set(["merge", "delete", "revert"]);
const ELEMENT_TYPES = new Set(["node", "way", "relation"]);
const ACTION_TYPES = new Set(["create", "modify", "delete"]);

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function isAdminRequest(req) {
  const expected = Buffer.from(String(process.env.DEV_ADMIN_KEY || ""));
  const actual = Buffer.from(String(req.headers["x-stepby-admin-key"] || ""));
  return expected.length >= 32 && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function writeGate() {
  if (process.env.OSM_WRITES_ENABLED !== "true") return { enabled: false, reason: "server_feature_flag_disabled" };
  if (process.env.OSM_COMMUNITY_APPROVED !== "true") return { enabled: false, reason: "community_approval_not_recorded" };
  if (!String(process.env.OSM_AUTOMATED_EDIT_WIKI_URL || "").trim()) return { enabled: false, reason: "automated_edit_wiki_url_missing" };
  if (!(await resolvedServiceAccountConfig()).configured) return { enabled: false, reason: "osm_service_account_not_configured" };
  return { enabled: true, reason: null };
}

async function writesEnabled() {
  return (await writeGate()).enabled;
}

function hasImmediateConfirmation(req, body, planId, action) {
  const header = String(req.headers["x-stepby-osm-confirm"] || "");
  const expected = `${action} ${planId}`;
  return header === expected && body && body.confirmation === expected;
}

function validateElements(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) return null;
  const elements = [];
  for (const item of value) {
    if (!item || !ELEMENT_TYPES.has(item.elementType) || !ACTION_TYPES.has(item.action)) return null;
    const osmId = item.osmId == null ? null : Number(item.osmId);
    const version = item.version == null ? null : Number(item.version);
    if (item.action !== "create" && (!Number.isSafeInteger(osmId) || osmId <= 0)) return null;
    if (item.action !== "create" && (!Number.isSafeInteger(version) || version <= 0)) return null;
    elements.push({
      elementType: item.elementType,
      action: item.action,
      osmId,
      version,
      before: item.before && typeof item.before === "object" ? item.before : null,
      after: item.after && typeof item.after === "object" ? item.after : null,
    });
  }
  return elements;
}

function createOsmChangesHandler({ sendJson, serviceClientFactory = createServiceAccountOsmClient }) {
  const { pool, error: dbError } = createDbPool();
  let initialized = false;

  async function ensureSchema() {
    if (initialized) return;
    if (!pool) throw dbError || new Error("database_unavailable");
    await pool.query("CREATE SCHEMA IF NOT EXISTS osmchange");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS osmchange.change_plans (
        plan_id UUID PRIMARY KEY,
        operation_type TEXT NOT NULL CHECK (operation_type IN ('merge', 'delete', 'revert')),
        created_by BIGINT NOT NULL,
        source_plan_id UUID,
        summary TEXT NOT NULL,
        elements JSONB NOT NULL,
        client_context JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS osmchange.audit_events (
        event_id BIGSERIAL PRIMARY KEY,
        plan_id UUID,
        event_type TEXT NOT NULL,
        actor_user_id BIGINT,
        request_id TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS osmchange.execution_attempts (
        attempt_id UUID PRIMARY KEY,
        plan_id UUID NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('execute', 'execute-revert')),
        actor_user_id BIGINT NOT NULL,
        request_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query("CREATE INDEX IF NOT EXISTS osm_change_plans_created_idx ON osmchange.change_plans(created_at DESC)");
    await pool.query("CREATE INDEX IF NOT EXISTS osm_audit_plan_idx ON osmchange.audit_events(plan_id, event_id)");
    await ensureRecordLinkSchema(pool);
    await ensureOptOutSchema(pool);
    await ensureReviewSchema(pool);
    await pool.query(`
      CREATE OR REPLACE FUNCTION osmchange.prevent_history_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'OSM change history is append-only';
      END $$
    `);
    await pool.query("DROP TRIGGER IF EXISTS osm_change_plans_append_only ON osmchange.change_plans");
    await pool.query(`CREATE TRIGGER osm_change_plans_append_only BEFORE UPDATE OR DELETE ON osmchange.change_plans
      FOR EACH ROW EXECUTE FUNCTION osmchange.prevent_history_mutation()`);
    await pool.query("DROP TRIGGER IF EXISTS osm_audit_events_append_only ON osmchange.audit_events");
    await pool.query(`CREATE TRIGGER osm_audit_events_append_only BEFORE UPDATE OR DELETE ON osmchange.audit_events
      FOR EACH ROW EXECUTE FUNCTION osmchange.prevent_history_mutation()`);
    await pool.query("DROP TRIGGER IF EXISTS osm_execution_attempts_append_only ON osmchange.execution_attempts");
    await pool.query(`CREATE TRIGGER osm_execution_attempts_append_only BEFORE UPDATE OR DELETE ON osmchange.execution_attempts
      FOR EACH ROW EXECUTE FUNCTION osmchange.prevent_history_mutation()`);
    initialized = true;
  }

  async function appendAudit(planId, eventType, req, details = {}) {
    await pool.query(
      `INSERT INTO osmchange.audit_events(plan_id,event_type,actor_user_id,request_id,details)
       VALUES(?,?,?,?,?::jsonb) RETURNING event_id`,
      [planId, eventType, req.authUserId || null, req.securityRequestId || null, JSON.stringify(details)]
    );
  }

  async function requireOwnedRecord(recordId, userId, executor = pool) {
    if (typeof recordId !== "string" || !recordId.trim() || recordId.length > 128) throw new Error("invalid_record_id");
    const [rows] = await executor.query(
      "SELECT session_id FROM tactile.sessions WHERE session_id=? AND user_id=? LIMIT 1",
      [recordId.trim(), userId]
    );
    if (!rows[0]) throw new Error("record_not_found_or_forbidden");
    return recordId.trim();
  }

  function buildReverseElements(plan, executionResult) {
    return executionResult
      ? createExecutableRevert(plan.elements, executionResult)
      : [...plan.elements].reverse().map((element) => ({
        ...element,
        action: element.action === "create" ? "delete" : "modify",
        before: element.after,
        after: element.before,
      }));
  }

  async function withPlanLock(planId, operation) {
    const conn = await pool.getConnection();
    try {
      await conn.query("SELECT pg_advisory_lock(hashtextextended(?,0))", [String(planId)]);
      return await operation();
    } finally {
      try { await conn.query("SELECT pg_advisory_unlock(hashtextextended(?,0))", [String(planId)]); } catch (_) {}
      conn.release();
    }
  }

  async function deactivateRevertedRecord(recordId, planId, req) {
    const [updated] = await pool.query(
      `UPDATE tactile.sessions SET is_active=FALSE
        WHERE session_id=? AND user_id=? AND is_active=TRUE
        RETURNING session_id`,
      [recordId, req.authUserId]
    );
    if (updated[0]) {
      await appendAudit(planId, "stepby_record_deactivated", req, {
        recordId,
        reason: "osm_revert_succeeded",
      });
    }
  }

  async function executeUserPlan(req, plan, action) {
    const planId = plan.plan_id;
    const gate = await writeGate();
    if (!gate.enabled) {
      await appendAudit(planId, "execution_blocked", req, { requestedAction: action, reason: gate.reason, authorization: "user_save_or_delete", editorMode: "stepby_service_account" });
      const error = new Error("osm_write_locked");
      error.status = 423;
      throw error;
    }
    await appendAudit(planId, "user_execution_requested", req, {
      requestedAction: action,
      authorization: action === "execute" ? "record_save" : "owned_green_line_delete",
      elementCount: plan.elements.length,
      osmApiBaseUrl: process.env.OSM_API_BASE_URL || null,
    });
    let client;
    try {
      client = await serviceClientFactory();
    } catch (error) {
      await appendAudit(planId, "execution_blocked", req, { requestedAction: action, reason: error.message || "osm_connection_required" });
      throw error;
    }
    const optOutMatch = await findOptOutMatch(pool, plan, client);
    if (optOutMatch) {
      await appendAudit(planId, "execution_blocked", req, {
        requestedAction: action,
        reason: "osm_opt_out_match",
        ruleId: optOutMatch.rule.rule_id,
        ruleType: optOutMatch.rule.rule_type,
        target: optOutMatch.operation,
      });
      const error = new Error("osm_opt_out_match");
      error.status = 409;
      throw error;
    }
    const attemptId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO osmchange.execution_attempts(attempt_id,plan_id,action,actor_user_id,request_id)
       VALUES(?,?,?,?,?) RETURNING attempt_id`,
      [attemptId, planId, action, req.authUserId, req.securityRequestId || null]
    );
    await appendAudit(planId, "execution_authorized", req, {
      attemptId, requestedAction: action, authorization: "user_save_or_delete", elementCount: plan.elements.length,
      editorMode: "stepby_service_account", serviceAccountName: (await resolvedServiceAccountConfig()).displayName,
      osmApiBaseUrl: process.env.OSM_API_BASE_URL || null,
    });
    try {
      const executionResult = await executeWithClient({
        client,
        operations: plan.elements,
        summary: plan.summary,
        planId,
        operationType: plan.operation_type,
        onChangesetCreated: async (changesetId) => {
          await appendAudit(planId, "changeset_created", req, { attemptId, requestedAction: action, changesetId });
        },
        onVersionsRebased: async (versionRebases) => {
          await appendAudit(planId, "execution_versions_rebased", req, {
            attemptId, requestedAction: action, versionRebases,
            reason: "version_changed_but_content_is_identical",
          });
        },
      });
      await appendAudit(planId, "execution_succeeded", req, {
        attemptId,
        requestedAction: action,
        executionResult,
        osmApiBaseUrl: process.env.OSM_API_BASE_URL || null,
      });
      if (plan.operation_type === "revert") {
        await pool.query(
          `UPDATE osmchange.record_links SET revert_changeset_id=?,osm_status='reverted',updated_at=NOW()
           WHERE revert_plan_id=?`, [executionResult.changesetId, planId]
        );
      } else {
        await pool.query(
          `UPDATE osmchange.record_links SET merge_changeset_id=?,osm_status='merged',updated_at=NOW()
           WHERE merge_plan_id=?`, [executionResult.changesetId, planId]
        );
      }
      const clearedWalkableCacheEntries = clearWalkableNetworkCache();
      await appendAudit(planId, "osm_read_cache_invalidated", req, {
        attemptId,
        requestedAction: action,
        clearedWalkableCacheEntries,
        reason: "osm_write_succeeded",
      });
      return { success: true, planId, attemptId, osmSent: true, executionResult };
    } catch (executionError) {
      await appendAudit(planId, "execution_failed", req, {
        attemptId, requestedAction: action, error: executionError.message,
        osmStatus: executionError.status || null,
        changesetId: executionError.changesetId || null,
        conflict: executionError.message === "osm_version_conflict" ? {
          elementType: executionError.elementType,
          osmId: executionError.osmId,
          expectedVersion: executionError.expectedVersion,
          currentVersion: executionError.currentVersion,
        } : null,
      });
      await pool.query(
        `UPDATE osmchange.record_links SET osm_status=?,updated_at=NOW()
         WHERE merge_plan_id=? OR revert_plan_id=?`,
        [executionError.message === "osm_version_conflict" ? "conflict" : "failed", planId, planId]
      );
      throw executionError;
    }
  }

  return async function handleOsmChanges(req, res) {
    if (process.env.NODE_ENV !== "development") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      // HTTP body may start streaming immediately, so capture it before awaiting DB initialization.
      const isExecutionRequest = req.method === "POST" && (/\/api\/osm\/plans\/[^/]+\/(execute|execute-revert)$/.test(url.pathname) || /\/api\/osm\/records\/[^/]+\/(publish|revert)$/.test(url.pathname) || /\/api\/osm\/reviews\/[^/]+\/(approve|reject|reopen)$/.test(url.pathname));
      const pendingBody = (["/api/osm/plans", "/api/osm/split-plan"].includes(url.pathname) || isExecutionRequest) && req.method === "POST"
        ? readJson(req)
        : null;
      await ensureSchema();
      const parts = url.pathname.split("/").filter(Boolean);

      if (url.pathname === "/api/osm/status" && req.method === "GET") {
        const gate = await writeGate();
        const service = await resolvedServiceAccountConfig();
        sendJson(res, 200, {
          success: true,
          environment: "development",
          proposalApiEnabled: true,
          osmNetworkCodePresent: true,
          osmWritesEnabled: gate.enabled,
          osmWriteGate: gate,
          osmEditorMode: "stepby_service_account",
          osmServiceAccountConfigured: service.configured,
          requiredSafeguards: ["server_feature_flag", "google_admin_allowlist", "administrator_review", "guest_exclusion", "service_account_oauth", "idempotency", "append_only_audit", "latest_osm_version"],
          reason: gate.enabled ? "Only administrator-approved non-guest records can be published" : "OSM write code is installed and locked by a server-side safeguard",
        });
        return;
      }

      if (url.pathname === "/api/osm/split-plan" && req.method === "POST") {
        const body = await pendingBody;
        const recordId = await requireOwnedRecord(body.recordId, req.authUserId);
        const [recordOwners] = await pool.query(`SELECT COALESCE(u.is_guest,FALSE) is_guest
          FROM tactile.sessions s LEFT JOIN login.users u ON u.user_id=s.user_id
          WHERE s.session_id=? AND s.user_id=? LIMIT 1`, [recordId, req.authUserId]);
        if (recordOwners[0] && recordOwners[0].is_guest) {
          await pool.query(`INSERT INTO osmchange.audit_events(plan_id,event_type,actor_user_id,request_id,details)
            VALUES(NULL,'guest_review_excluded',?,?,?::jsonb)`, [req.authUserId, req.securityRequestId || null,
            JSON.stringify({ recordId, osmSent: false, reviewQueued: false })]);
          sendJson(res, 200, { success: true, recordId, status: "guest_saved_stepby_only", reviewQueued: false, osmSent: false });
          return;
        }
        const publication = await getRecordPublication(pool, recordId, req.authUserId);
        if (!publication.osmEligible) {
          sendJson(res, 409, { error: "record_is_stepby_only", osmEligible: false });
          return;
        }
        const [existingLinks] = await pool.query(`SELECT l.merge_plan_id,l.osm_status,q.review_id,q.review_status
          FROM osmchange.record_links l LEFT JOIN osmchange.review_queue q ON q.record_id=l.record_id
          WHERE l.record_id=? AND l.created_by=? LIMIT 1`, [recordId, req.authUserId]);
        if (existingLinks[0]) {
          sendJson(res, 200, { success: true, recordId, planId: existingLinks[0].merge_plan_id,
            status: existingLinks[0].review_status || existingLinks[0].osm_status,
            reviewId: existingLinks[0].review_id || null, reviewQueued: Boolean(existingLinks[0].review_id),
            osmSent: existingLinks[0].osm_status === "merged", idempotent: true });
          return;
        }
        const planId = crypto.randomUUID();
        const summary = String(body.summary || "UI10 tactile paving split dry-run").trim().slice(0, 500);
        let splitPlan;
        try {
          splitPlan = createSplitPlan({ segments: body.segments }, { tactileValue: "yes" });
        } catch (plannerError) {
          if (plannerError.message !== "tactile_tag_already_present") throw plannerError;
          const skippedContext = {
            ...(body.clientContext && typeof body.clientContext === "object" ? body.clientContext : {}),
            previewOnly: false,
            osmWriteRequested: false,
            planner: "split_planner_v2_relations",
            recordId,
            publication: { osmEligible: true, containsStepByOnlyData: publication.hasPrivateTag },
            skipped: "tactile_tag_already_present",
            existingWayId: plannerError.wayId || null,
            existingTagKey: plannerError.tagKey || null,
          };
          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            const [existing] = await conn.query("SELECT merge_plan_id FROM osmchange.record_links WHERE record_id=? LIMIT 1", [recordId]);
            if (existing[0]) throw new Error("record_already_linked");
            await conn.query(
              `INSERT INTO osmchange.change_plans(plan_id,operation_type,created_by,source_plan_id,summary,elements,client_context)
               VALUES(?,?,?,?,?,'[]'::jsonb,?::jsonb) RETURNING plan_id`,
              [planId, "merge", req.authUserId, null, summary, JSON.stringify(skippedContext)]
            );
            await conn.query(
              `INSERT INTO osmchange.record_links(record_id,created_by,merge_plan_id,osm_status)
               VALUES(?,?,?,'already_present') RETURNING record_id`, [recordId, req.authUserId, planId]
            );
            await conn.query(
              `INSERT INTO osmchange.audit_events(plan_id,event_type,actor_user_id,request_id,details)
               VALUES(?,?,?,?,?::jsonb) RETURNING event_id`,
              [planId, "publication_skipped_existing_tactile", req.authUserId, req.securityRequestId || null,
                JSON.stringify({ recordId, osmSent: false, reason: plannerError.message,
                  wayId: plannerError.wayId || null, tagKey: plannerError.tagKey || null })]
            );
            await conn.commit();
          } catch (transactionError) {
            await conn.rollback();
            throw transactionError;
          } finally {
            conn.release();
          }
          sendJson(res, 200, { success: true, recordId, planId, status: "already_present",
            skipped: true, reason: plannerError.message, osmSent: false });
          return;
        }
        const clientContext = {
          ...(body.clientContext && typeof body.clientContext === "object" ? body.clientContext : {}),
          previewOnly: false,
          osmWriteRequested: false,
          reviewRequired: true,
          planner: "split_planner_v2_relations",
          recordId,
          publication: {
            osmEligible: true,
            containsStepByOnlyData: publication.hasPrivateTag,
          },
          splitSummary: splitPlan.summary,
        };
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const [existing] = await conn.query("SELECT merge_plan_id FROM osmchange.record_links WHERE record_id=? LIMIT 1", [recordId]);
          if (existing[0]) throw new Error("record_already_linked");
          await conn.query(
            `INSERT INTO osmchange.change_plans(plan_id,operation_type,created_by,source_plan_id,summary,elements,client_context)
             VALUES(?,?,?,?,?,?::jsonb,?::jsonb) RETURNING plan_id`,
            [planId, "merge", req.authUserId, null, summary, JSON.stringify(splitPlan.operations), JSON.stringify(clientContext)]
          );
          await conn.query(
            `INSERT INTO osmchange.record_links(record_id,created_by,merge_plan_id,osm_status)
             VALUES(?,?,?,'draft') RETURNING record_id`, [recordId, req.authUserId, planId]
          );
          await conn.query(
            `INSERT INTO osmchange.audit_events(plan_id,event_type,actor_user_id,request_id,details)
             VALUES(?,?,?,?,?::jsonb) RETURNING event_id`,
            [planId, "split_plan_created", req.authUserId, req.securityRequestId || null,
              JSON.stringify({ ...splitPlan.summary, recordId, osmSent: false })]
          );
          const review = await enqueueReview(conn, { recordId, planId, actorUserId: req.authUserId });
          await conn.commit();
          const notification = await queueNotification(pool, review.review_id);
          void deliverNotification(pool, { ...notification, reviewId: review.review_id })
            .catch((notificationError) => console.error("[osm_review] notification_failed", notificationError.message));
        } catch (transactionError) {
          await conn.rollback();
          throw transactionError;
        } finally {
          conn.release();
        }
        sendJson(res, 201, { success: true, recordId, planId, status: "pending_review", reviewQueued: true, osmSent: false, splitPlan });
        return;
      }

      if (parts[0] === "api" && parts[1] === "osm" && parts[2] === "reviews") {
        if (!(await isReviewAdmin(pool, req.authUserId))) {
          sendJson(res, 403, { error: "review_admin_required" });
          return;
        }
        if (req.method === "GET" && parts.length === 3) {
          const status = String(url.searchParams.get("status") || "pending");
          if (!["pending", "held", "approved", "rejected", "merge_failed", "merged", "all"].includes(status)) {
            sendJson(res, 400, { error: "invalid_review_status" }); return;
          }
          const clauses = [];
          const params = [];
          if (status !== "all") { clauses.push("q.review_status=?"); params.push(status); }
          const sourceType = String(url.searchParams.get("source") || "all");
          if (["new_record", "legacy_record"].includes(sourceType)) { clauses.push("q.source_type=?"); params.push(sourceType); }
          const query = String(url.searchParams.get("q") || "").trim().slice(0, 100);
          if (query) { clauses.push("(LOWER(COALESCE(q.source_metadata->>'username',u.username,'')) LIKE ? OR CAST(q.record_id AS TEXT) LIKE ? OR COALESCE(q.source_record_id,'') LIKE ?)"); const like = `%${query.toLowerCase()}%`; params.push(like, like, like); }
          const from = String(url.searchParams.get("from") || "");
          const to = String(url.searchParams.get("to") || "");
          if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { clauses.push("q.created_at>=?::date"); params.push(from); }
          if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { clauses.push("q.created_at<?::date + INTERVAL '1 day'"); params.push(to); }
          const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
          const [rows] = await pool.query(`SELECT q.review_id,q.record_id,q.plan_id,q.source_type,q.source_record_id,
              q.review_status,q.rejection_reason,q.admin_note,q.source_metadata,q.created_at,q.reviewed_at,
              COALESCE(q.source_metadata->>'username',u.username) username,
              COALESCE(ST_AsGeoJSON(p.geom::geometry),q.source_metadata->>'pathGeoJson') path_geojson,cp.elements,cp.client_context,
              (SELECT details->>'error' FROM osmchange.review_events re WHERE re.review_id=q.review_id AND re.event_type='merge_failed' ORDER BY re.event_id DESC LIMIT 1) last_error,
              (SELECT status FROM osmchange.review_notifications rn WHERE rn.review_id=q.review_id ORDER BY rn.created_at DESC LIMIT 1) notification_status,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('lat',ST_Y(g.geom::geometry),'lng',ST_X(g.geom::geometry),
                'accuracy',g.accuracy,'ts',g.ts) ORDER BY g.ts) FROM tactile.gps_raw g WHERE g.session_id=q.record_id),
                q.source_metadata->'rawPoints','[]'::jsonb) raw_points
            FROM osmchange.review_queue q
            JOIN osmchange.change_plans cp ON cp.plan_id=q.plan_id
            LEFT JOIN tactile.sessions s ON s.session_id=q.record_id
            LEFT JOIN login.users u ON u.user_id=s.user_id
            LEFT JOIN tactile.session_paths p ON p.session_id=q.record_id
            ${where} ORDER BY q.created_at DESC LIMIT 500`, params);
          sendJson(res, 200, { success: true, reviews: rows, count: rows.length }); return;
        }
        if (req.method === "POST" && parts[3]) {
          const reviewId = decodeURIComponent(parts[3]);
          const action = parts[4];
          const body = await pendingBody;
          const [rows] = await pool.query(`SELECT q.*,cp.operation_type,cp.created_by,cp.summary,cp.elements,cp.client_context
            FROM osmchange.review_queue q JOIN osmchange.change_plans cp ON cp.plan_id=q.plan_id
            WHERE q.review_id=? LIMIT 1`, [reviewId]);
          const review = rows[0];
          if (!review) { sendJson(res, 404, { error: "review_not_found" }); return; }
          if (action === "hold" || action === "memo") {
            const note = String(body && body.note || "").trim().slice(0, 2000);
            if (action === "hold") {
              await pool.query(`UPDATE osmchange.review_queue SET review_status='held',admin_note=?,reviewer_user_id=?,reviewed_at=NOW(),updated_at=NOW() WHERE review_id=?`, [note, req.authUserId, reviewId]);
            } else {
              await pool.query("UPDATE osmchange.review_queue SET admin_note=?,updated_at=NOW() WHERE review_id=?", [note, reviewId]);
            }
            await pool.query(`INSERT INTO osmchange.review_events(review_id,event_type,actor_user_id,details)
              VALUES(?,?,?,?::jsonb) RETURNING event_id AS id`, [reviewId, action === "hold" ? "held" : "admin_note_saved", req.authUserId, JSON.stringify({ note })]);
            sendJson(res, 200, { success: true, reviewId, status: action === "hold" ? "held" : review.review_status, osmSent: false }); return;
          }
          if (action === "retry-notification") {
            const [notifications] = await pool.query(`SELECT notification_id,review_id,recipient FROM osmchange.review_notifications
              WHERE review_id=? ORDER BY created_at DESC LIMIT 1`, [reviewId]);
            const notification = notifications[0]
              ? { notificationId: notifications[0].notification_id, reviewId: notifications[0].review_id, recipient: notifications[0].recipient }
              : await queueNotification(pool, reviewId);
            const result = await deliverNotification(pool, notification);
            sendJson(res, result.sent ? 200 : 502, { success: result.sent, reviewId, ...result }); return;
          }
          if (action === "reject") {
            const reason = String(body && body.reason || "").trim().slice(0, 1000);
            if (!reason) { sendJson(res, 400, { error: "rejection_reason_required" }); return; }
            await pool.query(`UPDATE osmchange.review_queue SET review_status='rejected',rejection_reason=?,
              reviewer_user_id=?,reviewed_at=NOW(),updated_at=NOW() WHERE review_id=?`, [reason, req.authUserId, reviewId]);
            await pool.query(`INSERT INTO osmchange.review_events(review_id,event_type,actor_user_id,details)
              VALUES(?,'rejected',?,?::jsonb) RETURNING event_id AS id`, [reviewId, req.authUserId, JSON.stringify({ reason })]);
            sendJson(res, 200, { success: true, reviewId, status: "rejected", osmSent: false }); return;
          }
          if (action === "reopen") {
            await pool.query(`UPDATE osmchange.review_queue SET review_status='pending',rejection_reason=NULL,
              reviewer_user_id=NULL,reviewed_at=NULL,updated_at=NOW() WHERE review_id=?`, [reviewId]);
            await pool.query(`INSERT INTO osmchange.review_events(review_id,event_type,actor_user_id,details)
              VALUES(?,'reopened',?,'{}'::jsonb) RETURNING event_id AS id`, [reviewId, req.authUserId]);
            sendJson(res, 200, { success: true, reviewId, status: "pending", osmSent: false }); return;
          }
          if (action === "approve") {
            if (!['pending','merge_failed','approved'].includes(review.review_status)) {
              sendJson(res, 409, { error: "review_not_approvable", status: review.review_status }); return;
            }
            await pool.query(`UPDATE osmchange.review_queue SET review_status='approved',rejection_reason=NULL,
              reviewer_user_id=?,reviewed_at=NOW(),updated_at=NOW() WHERE review_id=?`, [req.authUserId, reviewId]);
            await pool.query(`INSERT INTO osmchange.review_events(review_id,event_type,actor_user_id,details)
              VALUES(?,'approved',?,?::jsonb) RETURNING event_id AS id`, [reviewId, req.authUserId, JSON.stringify({ executeRequested: true })]);
            if (review.source_type === "legacy_record" && review.source_metadata && review.source_metadata.legacyNeedsRefit) {
              sendJson(res, 200, { success: true, reviewId, status: "approved", osmSent: false,
                executionDeferred: true, reason: "legacy_refit_required" }); return;
            }
            if (!(await writesEnabled())) {
              sendJson(res, 200, { success: true, reviewId, status: "approved", osmSent: false, executionDeferred: true }); return;
            }
            try {
              const result = await withPlanLock(review.plan_id, () => executeUserPlan(req, review, "execute"));
              await pool.query("UPDATE osmchange.review_queue SET review_status='merged',updated_at=NOW() WHERE review_id=?", [reviewId]);
              await pool.query(`INSERT INTO osmchange.review_events(review_id,event_type,actor_user_id,details)
                VALUES(?,'merged',?,?::jsonb) RETURNING event_id AS id`, [reviewId, req.authUserId, JSON.stringify({ changesetId: result.changesetId || null })]);
              sendJson(res, 200, { ...result, reviewId, status: "merged" }); return;
            } catch (executionError) {
              await pool.query("UPDATE osmchange.review_queue SET review_status='merge_failed',updated_at=NOW() WHERE review_id=?", [reviewId]);
              await pool.query(`INSERT INTO osmchange.review_events(review_id,event_type,actor_user_id,details)
                VALUES(?,'merge_failed',?,?::jsonb) RETURNING event_id AS id`, [reviewId, req.authUserId, JSON.stringify({ error: executionError.message })]);
              throw executionError;
            }
          }
          sendJson(res, 404, { error: "review_action_not_found" }); return;
        }
      }

      if (parts[0] === "api" && parts[1] === "osm" && parts[2] === "review-notifications" && parts[3] === "retry") {
        if (!(await isReviewAdmin(pool, req.authUserId))) { sendJson(res, 403, { error: "review_admin_required" }); return; }
        const results = await retryFailedNotifications(pool, 20);
        sendJson(res, 200, { success: true, attempted: results.length, sent: results.filter(item => item.sent).length }); return;
      }

      if (parts[0] === "api" && parts[1] === "osm" && parts[2] === "records" && parts[3]) {
        const recordId = decodeURIComponent(parts[3]);
        await requireOwnedRecord(recordId, req.authUserId);
        const [links] = await pool.query(
          `SELECT record_id,merge_plan_id,merge_changeset_id,revert_plan_id,revert_changeset_id,osm_status,created_at,updated_at
             FROM osmchange.record_links WHERE record_id=? AND created_by=? LIMIT 1`,
          [recordId, req.authUserId]
        );
        const link = links[0];
        if (!link) {
          sendJson(res, 404, { error: "osm_record_link_not_found" });
          return;
        }
        if (req.method === "GET" && parts.length === 4) {
          sendJson(res, 200, { success: true, record: link, osmSent: ["merged", "revert_draft", "reverted"].includes(link.osm_status) });
          return;
        }
        if (req.method === "POST" && parts[4] === "publish") {
          await appendAudit(link.merge_plan_id, "execution_blocked", req, { requestedAction: "execute", reason: "administrator_review_required" });
          sendJson(res, 409, { error: "administrator_review_required", reviewStatus: "pending", osmSent: false });
          return;
        }
        if (req.method === "POST" && parts[4] === "revert") {
          const body = await pendingBody;
          if (!body || body.authorization !== "owned_green_line_delete") {
            await appendAudit(link.merge_plan_id, "execution_blocked", req, { requestedAction: "execute-revert", reason: "green_line_delete_confirmation_required" });
            sendJson(res, 409, { error: "green_line_delete_confirmation_required", osmSent: false });
            return;
          }
          if (!(await writesEnabled())) {
            await appendAudit(link.merge_plan_id, "execution_blocked", req, { requestedAction: "execute-revert", reason: "server_feature_flag_disabled", authorization: "owned_green_line_delete" });
            sendJson(res, 423, { error: "osm_write_locked", osmSent: false });
            return;
          }
          const result = await withPlanLock(link.merge_plan_id, async () => {
            const [freshLinks] = await pool.query(
              `SELECT record_id,merge_plan_id,merge_changeset_id,revert_plan_id,revert_changeset_id,osm_status
                 FROM osmchange.record_links WHERE record_id=? AND created_by=? LIMIT 1`,
              [recordId, req.authUserId]
            );
            const freshLink = freshLinks[0];
            if (!freshLink) throw new Error("osm_record_link_not_found");
            if (freshLink.osm_status === "reverted") {
              await deactivateRevertedRecord(recordId, freshLink.revert_plan_id || freshLink.merge_plan_id, req);
              return { success: true, recordId, planId: freshLink.revert_plan_id, changesetId: freshLink.revert_changeset_id, osmSent: true, idempotent: true };
            }
            if (freshLink.osm_status !== "merged" && freshLink.osm_status !== "revert_draft" && freshLink.osm_status !== "failed") {
              const error = new Error(freshLink.osm_status === "conflict" ? "osm_version_conflict" : "record_not_merged");
              error.status = 409;
              throw error;
            }
            let revertPlanId = freshLink.revert_plan_id;
            if (!revertPlanId) {
              const [mergePlans] = await pool.query(
                `SELECT plan_id,summary,elements FROM osmchange.change_plans WHERE plan_id=? AND created_by=? LIMIT 1`,
                [freshLink.merge_plan_id, req.authUserId]
              );
              const mergePlan = mergePlans[0];
              if (!mergePlan) throw new Error("linked_plan_not_found");
              const [successEvents] = await pool.query(
                `SELECT details FROM osmchange.audit_events
                 WHERE plan_id=? AND event_type='execution_succeeded' ORDER BY event_id DESC LIMIT 1`, [freshLink.merge_plan_id]
              );
              const executionResult = successEvents[0] && successEvents[0].details && successEvents[0].details.executionResult;
              if (!executionResult) throw new Error("revert_not_executable");
              revertPlanId = crypto.randomUUID();
              const reverseElements = buildReverseElements(mergePlan, executionResult);
              const conn = await pool.getConnection();
              try {
                await conn.beginTransaction();
                await conn.query(
                  `INSERT INTO osmchange.change_plans(plan_id,operation_type,created_by,source_plan_id,summary,elements,client_context)
                   VALUES(?,?,?,?,?,?::jsonb,?::jsonb) RETURNING plan_id`,
                  [revertPlanId, "revert", req.authUserId, freshLink.merge_plan_id,
                    `StepBy記録 ${recordId} の取消し`.slice(0, 500), JSON.stringify(reverseElements),
                    JSON.stringify({ recordId, executable: true, sourceChangesetId: executionResult.changesetId })]
                );
                await conn.query(
                  `UPDATE osmchange.record_links SET revert_plan_id=?,osm_status='revert_draft',updated_at=NOW()
                   WHERE record_id=? AND created_by=? AND revert_plan_id IS NULL`,
                  [revertPlanId, recordId, req.authUserId]
                );
                await conn.query(
                  `INSERT INTO osmchange.audit_events(plan_id,event_type,actor_user_id,request_id,details)
                   VALUES(?,?,?,?,?::jsonb) RETURNING event_id`,
                  [revertPlanId, "revert_plan_created", req.authUserId, req.securityRequestId || null,
                    JSON.stringify({ recordId, sourcePlanId: freshLink.merge_plan_id, executable: true, authorization: "owned_green_line_delete", osmSent: false })]
                );
                await conn.commit();
              } catch (error) {
                await conn.rollback();
                throw error;
              } finally {
                conn.release();
              }
            }
            const [revertPlans] = await pool.query(
              `SELECT plan_id,operation_type,created_by,summary,elements,client_context
               FROM osmchange.change_plans WHERE plan_id=? AND created_by=? LIMIT 1`, [revertPlanId, req.authUserId]
            );
            const revertPlan = revertPlans[0];
            if (!revertPlan || revertPlan.operation_type !== "revert" || !revertPlan.client_context || !revertPlan.client_context.executable) {
              throw new Error("revert_not_executable");
            }
            const execution = await executeUserPlan(req, revertPlan, "execute-revert");
            await deactivateRevertedRecord(recordId, revertPlanId, req);
            return execution;
          });
          sendJson(res, 200, { ...result, recordId });
          return;
        }
        if (req.method === "POST" && parts[4] === "revert-plan") {
          if (link.revert_plan_id) {
            sendJson(res, 409, { error: "revert_plan_already_exists", planId: link.revert_plan_id, osmSent: false });
            return;
          }
          if (link.osm_status !== "merged" || !link.merge_changeset_id) {
            sendJson(res, 409, { error: "record_not_merged", status: link.osm_status, osmSent: false });
            return;
          }
          const [plans] = await pool.query(
            `SELECT plan_id,summary,elements FROM osmchange.change_plans WHERE plan_id=? LIMIT 1`, [link.merge_plan_id]
          );
          const plan = plans[0];
          if (!plan) throw new Error("linked_plan_not_found");
          const [successEvents] = await pool.query(
            `SELECT details FROM osmchange.audit_events
             WHERE plan_id=? AND event_type='execution_succeeded' ORDER BY event_id DESC LIMIT 1`, [link.merge_plan_id]
          );
          const executionResult = successEvents[0] && successEvents[0].details && successEvents[0].details.executionResult;
          const executable = Boolean(executionResult);
          const reverseElements = buildReverseElements(plan, executionResult);
          const revertPlanId = crypto.randomUUID();
          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            await conn.query(
              `INSERT INTO osmchange.change_plans(plan_id,operation_type,created_by,source_plan_id,summary,elements,client_context)
               VALUES(?,?,?,?,?,?::jsonb,?::jsonb) RETURNING plan_id`,
              [revertPlanId, "revert", req.authUserId, link.merge_plan_id, `Revert record ${recordId}: ${plan.summary}`.slice(0, 500),
                JSON.stringify(reverseElements), JSON.stringify({ recordId, executable, sourceChangesetId: executionResult && executionResult.changesetId || null })]
            );
            await conn.query(
              `UPDATE osmchange.record_links SET revert_plan_id=?,osm_status='revert_draft',updated_at=NOW()
               WHERE record_id=? AND created_by=? AND revert_plan_id IS NULL`,
              [revertPlanId, recordId, req.authUserId]
            );
            await conn.query(
              `INSERT INTO osmchange.audit_events(plan_id,event_type,actor_user_id,request_id,details)
               VALUES(?,?,?,?,?::jsonb) RETURNING event_id`,
              [revertPlanId, "revert_plan_created", req.authUserId, req.securityRequestId || null,
                JSON.stringify({ recordId, sourcePlanId: link.merge_plan_id, executable, osmSent: false })]
            );
            await conn.commit();
          } catch (transactionError) {
            await conn.rollback();
            throw transactionError;
          } finally {
            conn.release();
          }
          sendJson(res, 201, { success: true, recordId, planId: revertPlanId, sourcePlanId: link.merge_plan_id, status: "revert_draft", executable, osmSent: false });
          return;
        }
      }

      if (url.pathname === "/api/osm/plans" && req.method === "POST") {
        const body = await pendingBody;
        const operationType = String(body.operationType || "");
        const summary = String(body.summary || "").trim().slice(0, 500);
        const elements = validateElements(body.elements);
        if (!OPERATION_TYPES.has(operationType) || !summary || !elements) {
          sendJson(res, 400, { error: "invalid_change_plan" });
          return;
        }
        const planId = crypto.randomUUID();
        await pool.query(
          `INSERT INTO osmchange.change_plans(plan_id,operation_type,created_by,source_plan_id,summary,elements,client_context)
           VALUES(?,?,?,?,?,?::jsonb,?::jsonb) RETURNING plan_id`,
          [planId, operationType, req.authUserId, body.sourcePlanId || null, summary,
            JSON.stringify(elements), JSON.stringify(body.clientContext && typeof body.clientContext === "object" ? body.clientContext : {})]
        );
        await appendAudit(planId, "plan_created", req, { operationType, elementCount: elements.length });
        sendJson(res, 201, { success: true, planId, status: "draft", osmSent: false });
        return;
      }

      const planId = parts[3] || null;
      if (parts[0] === "api" && parts[1] === "osm" && parts[2] === "plans" && planId) {
        const [plans] = await pool.query(
          `SELECT plan_id,operation_type,created_by,source_plan_id,summary,elements,client_context,status,created_at
           FROM osmchange.change_plans WHERE plan_id=? LIMIT 1`, [planId]
        );
        const plan = plans[0];
        if (!plan) {
          sendJson(res, 404, { error: "plan_not_found" });
          return;
        }
        if (String(plan.created_by) !== String(req.authUserId) && !isAdminRequest(req)) {
          sendJson(res, 403, { error: "plan_access_denied" });
          return;
        }
        if (req.method === "GET" && parts.length === 4) {
          const [events] = await pool.query(
            `SELECT event_id,event_type,actor_user_id,request_id,details,created_at
             FROM osmchange.audit_events WHERE plan_id=? ORDER BY event_id`, [planId]
          );
          sendJson(res, 200, { success: true, plan, auditEvents: events, osmSent: false });
          return;
        }
        if (req.method === "POST" && parts[4] === "revert-plan") {
          const [linkedRecords] = await pool.query(
            "SELECT record_id FROM osmchange.record_links WHERE merge_plan_id=? LIMIT 1", [planId]
          );
          if (linkedRecords[0]) {
            sendJson(res, 409, {
              error: "use_record_revert_endpoint",
              recordId: linkedRecords[0].record_id,
              endpoint: `/api/osm/records/${encodeURIComponent(linkedRecords[0].record_id)}/revert-plan`,
              osmSent: false,
            });
            return;
          }
          const [successEvents] = await pool.query(
            `SELECT details FROM osmchange.audit_events
             WHERE plan_id=? AND event_type='execution_succeeded' ORDER BY event_id DESC LIMIT 1`, [planId]
          );
          const executionResult = successEvents[0] && successEvents[0].details && successEvents[0].details.executionResult;
          const executable = Boolean(executionResult);
          const reverseElements = buildReverseElements(plan, executionResult);
          const revertPlanId = crypto.randomUUID();
          await pool.query(
            `INSERT INTO osmchange.change_plans(plan_id,operation_type,created_by,source_plan_id,summary,elements,client_context)
             VALUES(?,?,?,?,?,?::jsonb,?::jsonb) RETURNING plan_id`,
            [revertPlanId, "revert", req.authUserId, planId, `Revert: ${plan.summary}`.slice(0, 500), JSON.stringify(reverseElements),
              JSON.stringify({ executable, sourceChangesetId: executionResult && executionResult.changesetId || null })]
          );
          await appendAudit(revertPlanId, "revert_plan_created", req, { sourcePlanId: planId, executable });
          sendJson(res, 201, { success: true, planId: revertPlanId, sourcePlanId: planId, status: "draft", executable, osmSent: false });
          return;
        }
        if (req.method === "POST" && ["execute", "execute-revert"].includes(parts[4])) {
          const action = parts[4];
          const body = await pendingBody;
          if (!(await writesEnabled())) {
            await appendAudit(planId, "execution_blocked", req, { requestedAction: action, reason: "server_feature_flag_disabled" });
            sendJson(res, 423, { error: "osm_write_locked", osmSent: false, message: "OSM_WRITES_ENABLED is not true" });
            return;
          }
          if (!isAdminRequest(req)) {
            await appendAudit(planId, "execution_blocked", req, { requestedAction: action, reason: "admin_required" });
            sendJson(res, 403, { error: "admin_required", osmSent: false });
            return;
          }
          if (!hasImmediateConfirmation(req, body, planId, action)) {
            await appendAudit(planId, "execution_blocked", req, { requestedAction: action, reason: "immediate_confirmation_required" });
            sendJson(res, 409, { error: "osm_confirmation_required", osmSent: false, expected: `${action} ${planId}` });
            return;
          }
          if (action === "execute-revert" && (plan.operation_type !== "revert" || !plan.client_context || !plan.client_context.executable)) {
            await appendAudit(planId, "execution_blocked", req, { requestedAction: action, reason: "revert_not_executable" });
            sendJson(res, 409, { error: "revert_not_executable", osmSent: false });
            return;
          }
          const attemptId = crypto.randomUUID();
          await pool.query(
            `INSERT INTO osmchange.execution_attempts(attempt_id,plan_id,action,actor_user_id,request_id)
             VALUES(?,?,?,?,?) RETURNING attempt_id`,
            [attemptId, planId, action, req.authUserId, req.securityRequestId || null]
          );
          await appendAudit(planId, "execution_authorized", req, { attemptId, requestedAction: action, elementCount: plan.elements.length });
          try {
            const executionResult = await executeWithClient({
              client: await serviceClientFactory(),
              operations: plan.elements,
              summary: plan.summary,
              planId,
              operationType: plan.operation_type,
              onChangesetCreated: async (changesetId) => {
                await appendAudit(planId, "changeset_created", req, { attemptId, requestedAction: action, changesetId });
              },
            });
            await appendAudit(planId, "execution_succeeded", req, { attemptId, requestedAction: action, executionResult });
            if (plan.operation_type === "revert") {
              await pool.query(
                `UPDATE osmchange.record_links SET revert_changeset_id=?,osm_status='reverted',updated_at=NOW()
                 WHERE revert_plan_id=?`, [executionResult.changesetId, planId]
              );
            } else {
              await pool.query(
                `UPDATE osmchange.record_links SET merge_changeset_id=?,osm_status='merged',updated_at=NOW()
                 WHERE merge_plan_id=?`, [executionResult.changesetId, planId]
              );
            }
            sendJson(res, 200, { success: true, planId, attemptId, osmSent: true, executionResult });
          } catch (executionError) {
            await appendAudit(planId, "execution_failed", req, {
              attemptId, requestedAction: action, error: executionError.message,
              osmStatus: executionError.status || null,
              changesetId: executionError.changesetId || null,
              conflict: executionError.message === "osm_version_conflict" ? {
                elementType: executionError.elementType,
                osmId: executionError.osmId,
                expectedVersion: executionError.expectedVersion,
                currentVersion: executionError.currentVersion,
              } : null,
            });
            await pool.query(
              `UPDATE osmchange.record_links SET osm_status=?,updated_at=NOW()
               WHERE merge_plan_id=? OR revert_plan_id=?`,
              [executionError.message === "osm_version_conflict" ? "conflict" : "failed", planId, planId]
            );
            const responseStatus = executionError.message === "osm_version_conflict" ? 409 : 502;
            sendJson(res, responseStatus, { error: executionError.message === "osm_version_conflict" ? "osm_version_conflict" : "osm_execution_failed", message: executionError.message, planId, attemptId, osmSent: false });
          }
          return;
        }
        if (req.method === "POST" && ["approve", "delete-elements"].includes(parts[4])) {
          await appendAudit(planId, "execution_blocked", req, {
            requestedAction: parts[4],
            adminPresented: isAdminRequest(req),
            reason: "osm_write_locked",
          });
          sendJson(res, 423, {
            error: "osm_write_locked",
            osmSent: false,
            message: "OSM write and delete execution are intentionally unavailable",
          });
          return;
        }
      }

      if (url.pathname === "/api/osm/audit-events" && req.method === "GET") {
        if (!isAdminRequest(req)) {
          sendJson(res, 403, { error: "admin_required" });
          return;
        }
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        const [events] = await pool.query(
          `SELECT event_id,plan_id,event_type,actor_user_id,request_id,details,created_at
           FROM osmchange.audit_events ORDER BY event_id DESC LIMIT ?`, [limit]
        );
        sendJson(res, 200, { success: true, events });
        return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (error) {
      const clientErrors = new Set([
        "invalid_segments", "inconsistent_duplicate_way", "invalid_way_identity", "invalid_way_geometry",
        "invalid_boundary", "invalid_node_boundary", "invalid_projection_boundary",
        "invalid_boundary_fraction", "invalid_boundary_lng", "invalid_boundary_lat", "zero_length_tactile_segment",
        "invalid_relation", "inconsistent_relation", "invalid_record_id", "record_not_found_or_forbidden", "record_already_linked",
        "missing_highway_tag", "missing_side_for_roadway", "non_walkway_way_not_eligible",
        "tactile_no_to_yes_required", "tactile_tag_already_present",
      ]);
      const status = Number.isInteger(error.status) ? error.status
        : error.message === "record_not_found_or_forbidden" ? 404
        : error.message === "record_already_linked" ? 409
        : ["osm_connection_required", "record_not_merged", "revert_not_executable", "osm_version_conflict"].includes(error.message) ? 409
        : error.message === "osm_write_locked" ? 423
        : ["non_walkway_way_not_eligible", "tactile_no_to_yes_required", "tactile_tag_already_present"].includes(error.message) ? 422
        : error.message === "invalid_json" || clientErrors.has(error.message) ? 400
        : error.message === "body_too_large" ? 413 : 500;
      console.error("[osm_changes] request failed:", error.message);
      sendJson(res, status, { error: status === 500 ? "osm_change_api_failed" : error.message, osmSent: false });
    }
  };
}

module.exports = createOsmChangesHandler;
