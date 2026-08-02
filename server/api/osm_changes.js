const crypto = require("crypto");
const { createDbPool } = require("../db");

const MAX_BODY_BYTES = 256 * 1024;
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
    await pool.query("CREATE INDEX IF NOT EXISTS osm_change_plans_created_idx ON osmchange.change_plans(created_at DESC)");
    await pool.query("CREATE INDEX IF NOT EXISTS osm_audit_plan_idx ON osmchange.audit_events(plan_id, event_id)");
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
    initialized = true;
  }

  async function appendAudit(planId, eventType, req, details = {}) {
    await pool.query(
      `INSERT INTO osmchange.audit_events(plan_id,event_type,actor_user_id,request_id,details)
       VALUES(?,?,?,?,?::jsonb) RETURNING event_id`,
      [planId, eventType, req.authUserId || null, req.securityRequestId || null, JSON.stringify(details)]
    );
  }

  return async function handleOsmChanges(req, res) {
    if (process.env.NODE_ENV !== "development") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      // HTTP body may start streaming immediately, so capture it before awaiting DB initialization.
      const pendingBody = url.pathname === "/api/osm/plans" && req.method === "POST"
        ? readJson(req)
        : null;
      await ensureSchema();
      const parts = url.pathname.split("/").filter(Boolean);

      if (url.pathname === "/api/osm/status" && req.method === "GET") {
        sendJson(res, 200, {
          success: true,
          environment: "development",
          proposalApiEnabled: true,
          osmNetworkCodePresent: false,
          osmWritesEnabled: false,
          reason: "OSM write execution is intentionally not implemented and is locked off",
        });
        return;
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
          const reverseElements = [...plan.elements].reverse().map((element) => ({
            ...element,
            action: element.action === "create" ? "delete" : element.action === "delete" ? "create" : "modify",
            before: element.after,
            after: element.before,
          }));
          const revertPlanId = crypto.randomUUID();
          await pool.query(
            `INSERT INTO osmchange.change_plans(plan_id,operation_type,created_by,source_plan_id,summary,elements,client_context)
             VALUES(?,?,?,?,?,?::jsonb,'{}'::jsonb) RETURNING plan_id`,
            [revertPlanId, "revert", req.authUserId, planId, `Revert: ${plan.summary}`.slice(0, 500), JSON.stringify(reverseElements)]
          );
          await appendAudit(revertPlanId, "revert_plan_created", req, { sourcePlanId: planId });
          sendJson(res, 201, { success: true, planId: revertPlanId, sourcePlanId: planId, status: "draft", osmSent: false });
          return;
        }
        if (req.method === "POST" && ["approve", "execute", "delete-elements", "execute-revert"].includes(parts[4])) {
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
      const status = error.message === "invalid_json" ? 400 : error.message === "body_too_large" ? 413 : 500;
      console.error("[osm_changes] request failed:", error.message);
      sendJson(res, status, { error: status === 500 ? "osm_change_api_failed" : error.message });
    }
  };
}

module.exports = createOsmChangesHandler;
