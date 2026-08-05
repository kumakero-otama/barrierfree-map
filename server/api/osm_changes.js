const crypto = require("crypto");
const { createDbPool } = require("../db");
const { createSplitPlan } = require("../osm/split_planner");
const { executeWithClient, createConfiguredClient } = require("../osm/osm_executor");
const { createExecutableRevert } = require("../osm/revert_planner");
const { ensureRecordLinkSchema } = require("../osm/record_links");

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

function writesEnabled() {
  return process.env.OSM_WRITES_ENABLED === "true";
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

function createOsmChangesHandler({ sendJson }) {
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

  return async function handleOsmChanges(req, res) {
    if (process.env.NODE_ENV !== "development") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      // HTTP body may start streaming immediately, so capture it before awaiting DB initialization.
      const isExecutionRequest = req.method === "POST" && /\/api\/osm\/plans\/[^/]+\/(execute|execute-revert)$/.test(url.pathname);
      const pendingBody = (["/api/osm/plans", "/api/osm/split-plan"].includes(url.pathname) || isExecutionRequest) && req.method === "POST"
        ? readJson(req)
        : null;
      await ensureSchema();
      const parts = url.pathname.split("/").filter(Boolean);

      if (url.pathname === "/api/osm/status" && req.method === "GET") {
        sendJson(res, 200, {
          success: true,
          environment: "development",
          proposalApiEnabled: true,
          osmNetworkCodePresent: true,
          osmWritesEnabled: writesEnabled(),
          requiredSafeguards: ["server_feature_flag", "admin_key", "per_request_plan_confirmation", "append_only_audit"],
          reason: writesEnabled() ? "OSM write code is enabled but still requires per-request safeguards" : "OSM write code is installed and locked by the server feature flag",
        });
        return;
      }

      if (url.pathname === "/api/osm/split-plan" && req.method === "POST") {
        const body = await pendingBody;
        const recordId = await requireOwnedRecord(body.recordId, req.authUserId);
        const splitPlan = createSplitPlan({ segments: body.segments }, { tactileValue: "yes" });
        const planId = crypto.randomUUID();
        const summary = String(body.summary || "UI10 tactile paving split dry-run").trim().slice(0, 500);
        const clientContext = {
          ...(body.clientContext && typeof body.clientContext === "object" ? body.clientContext : {}),
          previewOnly: true,
          osmWriteRequested: false,
          planner: "split_planner_v2_relations",
          recordId,
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
          await conn.commit();
        } catch (transactionError) {
          await conn.rollback();
          throw transactionError;
        } finally {
          conn.release();
        }
        sendJson(res, 201, { success: true, recordId, planId, status: "draft", osmSent: false, splitPlan });
        return;
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
          if (!writesEnabled()) {
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
              client: createConfiguredClient(),
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
        "invalid_segments", "duplicate_way_in_route", "invalid_way_identity", "invalid_way_geometry",
        "invalid_boundary", "invalid_node_boundary", "invalid_projection_boundary",
        "invalid_boundary_fraction", "invalid_boundary_lng", "invalid_boundary_lat", "zero_length_tactile_segment",
        "invalid_relation", "inconsistent_relation", "invalid_record_id", "record_not_found_or_forbidden", "record_already_linked",
        "missing_highway_tag", "missing_side_for_roadway",
      ]);
      const status = error.message === "record_not_found_or_forbidden" ? 404
        : error.message === "record_already_linked" ? 409
        : error.message === "invalid_json" || clientErrors.has(error.message) ? 400
        : error.message === "body_too_large" ? 413 : 500;
      console.error("[osm_changes] request failed:", error.message);
      sendJson(res, status, { error: status === 500 ? "osm_change_api_failed" : error.message });
    }
  };
}

module.exports = createOsmChangesHandler;
