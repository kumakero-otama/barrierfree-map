const fs = require("fs");
const path = require("path");
const yaml = require("yaml");
const { Pool } = require("pg");

const MAX_BODY_BYTES = 64 * 1024;

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

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

function createExperimentPool() {
  try {
    const configPath = path.resolve(process.env.EXPERIMENT_DB_CONFIG_PATH || "config.experiment.dev.yaml");
    const db = yaml.parse(fs.readFileSync(configPath, "utf8")).db;
    return { pool: new Pool({ host: db.host, port: db.port || 5432, user: db.user, password: db.password,
      database: db.database, max: 3, ssl: db.ssl ? { rejectUnauthorized: false } : undefined }), error: null };
  } catch (error) {
    return { pool: null, error };
  }
}

function createFittingComparisonsHandler({ sendJson }) {
  const { pool, error: dbError } = createExperimentPool();

  return async function handleFittingComparisons(req, res) {
    if (process.env.NODE_ENV !== "development") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!pool) {
      sendJson(res, 503, { error: "experiment_database_unavailable", message: dbError && dbError.message });
      return;
    }
    if (req.method === "GET") {
      try {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        const result = await pool.query(
          `SELECT id, experiment_session_uuid, user_id, observed_at, raw_lat, raw_lng,
                  valhalla_lat, valhalla_lng, valhalla_way_id, valhalla_distance_m,
                  browser_lat, browser_lng, browser_way_id, browser_way_version,
                  browser_distance_m, browser_priority, result_distance_m, way_match,
                  browser_connected, valhalla_duration_ms, browser_duration_ms,
                  status, error_message, client_version, created_at
            FROM experiment.fitting_comparisons ORDER BY id DESC LIMIT $1`,
          [limit]
        );
        sendJson(res, 200, { success: true, count: result.rows.length, comparisons: result.rows });
      } catch (error) {
        console.error("[fitting_comparisons] list failed:", error.message);
        sendJson(res, 500, { error: "comparison_list_failed" });
      }
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    try {
      const body = await readJson(req);
      const rawLat = finiteOrNull(body.rawLat);
      const rawLng = finiteOrNull(body.rawLng);
      const userId = String(req.authUserId || "").trim();
      if (body.userId != null && String(body.userId) !== userId) {
        sendJson(res, 403, { error: "user_mismatch" });
        return;
      }
      if (!userId || rawLat === null || rawLng === null || rawLat < -90 || rawLat > 90 || rawLng < -180 || rawLng > 180) {
        sendJson(res, 400, { error: "invalid_comparison" });
        return;
      }
      const values = [
        body.sessionId ? String(body.sessionId) : null, userId, body.observedAt || new Date().toISOString(), rawLat, rawLng,
        finiteOrNull(body.valhallaLat), finiteOrNull(body.valhallaLng), integerOrNull(body.valhallaWayId), finiteOrNull(body.valhallaDistanceMeters),
        finiteOrNull(body.browserLat), finiteOrNull(body.browserLng), integerOrNull(body.browserWayId), integerOrNull(body.browserWayVersion),
        finiteOrNull(body.browserDistanceMeters), body.browserPriority ? String(body.browserPriority) : null,
        finiteOrNull(body.resultDistanceMeters), typeof body.wayMatch === "boolean" ? body.wayMatch : null,
        typeof body.browserConnected === "boolean" ? body.browserConnected : null,
        integerOrNull(body.valhallaDurationMs), integerOrNull(body.browserDurationMs), String(body.status || "compared").slice(0, 40),
        body.errorMessage ? String(body.errorMessage).slice(0, 1000) : null,
        body.clientVersion ? String(body.clientVersion).slice(0, 80) : null,
        JSON.stringify(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      ];
      const result = await pool.query(
        `INSERT INTO experiment.fitting_comparisons (
          experiment_session_uuid,user_id,observed_at,raw_lat,raw_lng,valhalla_lat,valhalla_lng,valhalla_way_id,valhalla_distance_m,
          browser_lat,browser_lng,browser_way_id,browser_way_version,browser_distance_m,browser_priority,result_distance_m,way_match,
          browser_connected,valhalla_duration_ms,browser_duration_ms,status,error_message,client_version,metadata
        ) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")}) RETURNING id`, values
      );
      sendJson(res, 201, { success: true, id: result.rows[0].id });
    } catch (error) {
      console.error("[fitting_comparisons] save failed:", error.message);
      sendJson(res, error.message === "invalid_json" ? 400 : 500, { error: "comparison_save_failed" });
    }
  };
}

module.exports = createFittingComparisonsHandler;
