const { createDbPool } = require("../db");

function createHealthHandler({ sendJson }) {
  const { pool, error } = createDbPool();
  return async function handleHealth(req, res) {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
    const checks = {
      api: "ok",
      database: pool ? "checking" : "unavailable",
      osmWrites: process.env.OSM_WRITES_ENABLED === "true" && process.env.OSM_COMMUNITY_APPROVED === "true" ? "enabled" : "locked",
      osmEditorMode: "stepby_service_account",
      osmServiceAccountConfigured: Boolean(String(process.env.OSM_SERVICE_ACCESS_TOKEN || "").trim() && String(process.env.OSM_SERVICE_ACCOUNT_NAME || "").trim()),
      osmOAuth: process.env.OSM_OAUTH_CLIENT_ID ? "configured" : "not_configured",
    };
    if (pool) {
      try {
        await pool.query("SELECT 1 health_check");
        checks.database = "ok";
      } catch {
        checks.database = "unavailable";
      }
    }
    const healthy = checks.database === "ok";
    sendJson(res, healthy ? 200 : 503, {
      success: healthy,
      environment: process.env.NODE_ENV || "unknown",
      checks,
      databaseError: healthy || !error ? undefined : error.message,
      checkedAt: new Date().toISOString(),
    });
  };
}

module.exports = createHealthHandler;
