const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const { createDbPool } = require("../db");
const { ensureReviewSchema } = require("../osm/review_queue");

const TABLES = Object.freeze({
  "tactile.sessions": {
    label: "点字ブロック記録セッション",
    rows: `SELECT session_id,user_id,started_at,ended_at,is_active
             FROM tactile.sessions ORDER BY started_at DESC LIMIT ?`,
  },
  "tactile.session_paths": {
    label: "確定経路",
    rows: `SELECT session_id,source,created_at,ST_AsGeoJSON(geom::geometry) geometry
             FROM tactile.session_paths ORDER BY created_at DESC LIMIT ?`,
  },
  "tactile.gps_raw": {
    label: "GPS生座標",
    rows: `SELECT session_id,ts,accuracy,ST_X(geom::geometry) lng,ST_Y(geom::geometry) lat
             FROM tactile.gps_raw ORDER BY ts DESC LIMIT ?`,
  },
  "tactile.gps_matched": {
    label: "ブラウザフィット点",
    rows: `SELECT session_id,ts,edge_id,confidence,ST_X(geom::geometry) lng,ST_Y(geom::geometry) lat
             FROM tactile.gps_matched ORDER BY ts DESC LIMIT ?`,
  },
  "tactile.way_snapshots": {
    label: "記録時Way座標バックアップ",
    rows: `SELECT snapshot_id,record_id,segment_order,way_id,way_version,node_ids,full_coordinates,
                  segment_from,segment_to,original_tags,relation_context,tactile_side,planned_tags,source,captured_at
             FROM tactile.way_snapshots ORDER BY captured_at DESC LIMIT ?`,
  },
  "osmchange.record_links": {
    label: "StepBy記録とOSM変更案の対応",
    rows: `SELECT record_id,merge_plan_id,merge_changeset_id,revert_plan_id,revert_changeset_id,
                  osm_status,created_at,updated_at
             FROM osmchange.record_links ORDER BY created_at DESC LIMIT ?`,
  },
  "osmchange.change_plans": {
    label: "OSM dry-run変更案",
    rows: `SELECT plan_id,operation_type,created_by,source_plan_id,summary,status,created_at
             FROM osmchange.change_plans ORDER BY created_at DESC LIMIT ?`,
  },
  "osmchange.audit_events": {
    label: "OSM追記型監査履歴",
    rows: `SELECT event_id,plan_id,event_type,actor_user_id,request_id,details,created_at
             FROM osmchange.audit_events ORDER BY created_at DESC LIMIT ?`,
  },
  "osmchange.review_queue": {
    label: "OSM公開前の審査キュー",
    rows: `SELECT review_id,record_id,plan_id,source_type,source_record_id,review_status,
                  rejection_reason,reviewer_user_id,reviewed_at,created_at,updated_at
             FROM osmchange.review_queue ORDER BY created_at DESC LIMIT ?`,
  },
  "osmchange.review_events": {
    label: "OSM審査の追記履歴",
    rows: `SELECT event_id,review_id,event_type,actor_user_id,details,created_at
             FROM osmchange.review_events ORDER BY event_id DESC LIMIT ?`,
  },
  "osmchange.review_notifications": {
    label: "OSM審査メール通知",
    rows: `SELECT notification_id,review_id,recipient,status,attempt_count,last_error,sent_at,created_at,updated_at
             FROM osmchange.review_notifications ORDER BY created_at DESC LIMIT ?`,
  },
  "experiment.api_records": {
    label: "API作成・削除実験データ",
    rows: `SELECT experiment_id,label,payload,created_by,created_at
             FROM experiment.api_records ORDER BY created_at DESC LIMIT ?`,
  },
  "experiment.api_record_audit": {
    label: "API実験監査履歴",
    rows: `SELECT event_id,experiment_id,event_type,actor_user_id,payload_digest,created_at
             FROM experiment.api_record_audit ORDER BY created_at DESC LIMIT ?`,
  },
  "experiment.fitting_replay_runs": {
    label: "保存済みGPSのフィッティング再検証",
    rows: `SELECT run_id,session_id,raw_point_count,network_way_count,status,score,browser_result,valhalla_result,osm_sent,created_at
             FROM experiment.fitting_replay_runs ORDER BY created_at DESC LIMIT ?`,
  },
  "experiment.production_record_imports": {
    label: "本番DB読取専用コピー履歴",
    rows: `SELECT import_id,development_session_id,source_session_digest,raw_point_count,matched_point_count,note,imported_at
             FROM experiment.production_record_imports ORDER BY imported_at DESC LIMIT ?`,
  },
  "experiment.gps_replay_runs": {
    label: "時刻順GPS再生試験",
    rows: `SELECT replay_id,session_id,event_count,historical_way_ids,replay_result,status,osm_sent,created_at
             FROM experiment.gps_replay_runs ORDER BY created_at DESC LIMIT ?`,
  },
  "experiment.production_fitting_batches": {
    label: "本番全記録フィッティング比較集計",
    rows: `SELECT batch_id,total_records,eligible_records,status,summary,started_at,completed_at
             FROM experiment.production_fitting_batches ORDER BY started_at DESC LIMIT ?`,
  },
  "experiment.production_fitting_batch_results": {
    label: "本番全記録フィッティング比較結果",
    rows: `SELECT batch_id,source_session_digest,started_at,raw_point_count,status,browser_result,valhalla_result,error,created_at
             FROM experiment.production_fitting_batch_results ORDER BY created_at DESC LIMIT ?`,
  },
  "experiment.fitting_outlier_maps": {
    label: "フィッティング要確認経路",
    rows: `SELECT batch_id,source_session_digest,started_at,raw_point_count,difference_m,connected,
                  browser_way_ids,valhalla_way_ids,created_at
             FROM experiment.fitting_outlier_maps ORDER BY difference_m DESC LIMIT ?`,
  },
});

function readJson(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) reject(new Error("payload_too_large"));
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function digest(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

function readLatestHealthObservation() {
  const file = process.env.STEPBY_HEALTH_CSV || "/var/lib/stepby-health/hourly.csv";
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return null;
    const headers = lines[0].split(",");
    const values = lines[lines.length - 1].split(",");
    return Object.fromEntries(headers.map((header, index) => [header, values[index] == null ? null : values[index]]));
  } catch {
    return null;
  }
}

function createAdminDatabaseHandler({ sendJson }) {
  const { pool, error } = createDbPool();
  let schemaReady = null;

  async function ensureSchema() {
    if (schemaReady) return schemaReady;
    schemaReady = (async () => {
      if (error || !pool) throw error || new Error("database_unavailable");
      await ensureReviewSchema(pool);
      await pool.query("CREATE SCHEMA IF NOT EXISTS experiment");
      await pool.query(`CREATE TABLE IF NOT EXISTS tactile.way_snapshots (
        snapshot_id uuid PRIMARY KEY,record_id uuid NOT NULL,segment_order integer NOT NULL CHECK(segment_order>=0),
        way_id bigint NOT NULL,way_version integer NOT NULL CHECK(way_version>0),node_ids jsonb NOT NULL,
        full_coordinates jsonb NOT NULL,segment_from jsonb NOT NULL,segment_to jsonb NOT NULL,
        original_tags jsonb NOT NULL,relation_context jsonb NOT NULL DEFAULT '[]'::jsonb,
        tactile_side text CHECK(tactile_side IS NULL OR tactile_side IN ('left','right')),
        planned_tags jsonb NOT NULL DEFAULT '{}'::jsonb,source text NOT NULL DEFAULT 'browser_osm_snapshot',
        captured_at timestamptz NOT NULL DEFAULT NOW(),UNIQUE(record_id,segment_order))`);
      await pool.query(`CREATE TABLE IF NOT EXISTS experiment.api_records (
        experiment_id uuid PRIMARY KEY,label text NOT NULL,payload jsonb NOT NULL,
        created_by bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS experiment.api_record_audit (
        event_id uuid PRIMARY KEY,experiment_id uuid NOT NULL,event_type text NOT NULL CHECK(event_type IN ('created','deleted')),
        actor_user_id bigint NOT NULL,payload_digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS experiment.fitting_replay_runs (
        run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid NOT NULL,requested_by text NOT NULL,
        raw_point_count integer NOT NULL,network_way_count integer NOT NULL,browser_result jsonb NOT NULL,
        valhalla_result jsonb,score jsonb NOT NULL,status text NOT NULL,osm_sent boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT NOW())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS experiment.production_record_imports(
        import_id uuid PRIMARY KEY,development_session_id uuid UNIQUE NOT NULL,source_session_digest text NOT NULL,
        raw_point_count integer NOT NULL,matched_point_count integer NOT NULL,imported_at timestamptz NOT NULL DEFAULT NOW(),
        note text NOT NULL)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS experiment.gps_replay_runs(
        replay_id uuid PRIMARY KEY,session_id uuid NOT NULL,requested_by text NOT NULL,event_count integer NOT NULL,
        historical_way_ids jsonb NOT NULL,replay_result jsonb NOT NULL,status text NOT NULL,
        osm_sent boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT NOW())`);
    })().catch((schemaError) => { schemaReady = null; throw schemaError; });
    return schemaReady;
  }

  return async function handleAdminDatabase(req, res) {
    if (process.env.NODE_ENV !== "development") return sendJson(res, 404, { error: "not_found" });
    try {
      await ensureSchema();
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/api/admin/database-overview" && req.method === "GET") {
        const [databaseRows] = await pool.query("SELECT current_database() database_name,pg_database_size(current_database()) bytes");
        const tables = [];
        for (const [key, config] of Object.entries(TABLES)) {
          const [schema, table] = key.split(".");
          const [rows] = await pool.query(
            `SELECT COUNT(*)::bigint row_count,pg_total_relation_size(?::regclass) bytes FROM ${schema}.${table}`,
            [key]
          );
          tables.push({ key, label: config.label, rowCount: Number(rows[0].row_count), bytes: Number(rows[0].bytes) });
        }
        return sendJson(res, 200, { success: true, environment: "development", database: databaseRows[0], tables });
      }

      if (url.pathname === "/api/admin/operations-overview" && req.method === "GET") {
        const [databaseRows] = await pool.query("SELECT pg_database_size(current_database()) bytes,NOW() checked_at");
        const [osmRows] = await pool.query(`SELECT
          COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '24 hours')::bigint events_24h,
          COUNT(*) FILTER (WHERE event_type='execution_succeeded' AND created_at >= NOW()-INTERVAL '24 hours')::bigint succeeded_24h,
          COUNT(*) FILTER (WHERE event_type='execution_failed' AND created_at >= NOW()-INTERVAL '24 hours')::bigint failed_24h,
          COUNT(*) FILTER (WHERE event_type='execution_blocked' AND created_at >= NOW()-INTERVAL '24 hours')::bigint blocked_24h,
          MAX(created_at) FILTER (WHERE event_type='execution_succeeded') last_osm_success_at
          FROM osmchange.audit_events`);
        const [linkRows] = await pool.query(`SELECT
          COUNT(*) FILTER (WHERE osm_status='merged')::bigint merged,
          COUNT(*) FILTER (WHERE osm_status='reverted')::bigint reverted,
          COUNT(*) FILTER (WHERE osm_status='conflict')::bigint conflicts,
          COUNT(*) FILTER (WHERE osm_status='failed')::bigint failed,
          COUNT(*) FILTER (WHERE osm_status='already_present')::bigint already_present
          FROM osmchange.record_links`);
        const [sessionRows] = await pool.query(`SELECT COUNT(*)::bigint total,
          COUNT(*) FILTER (WHERE started_at >= NOW()-INTERVAL '24 hours')::bigint created_24h
          FROM tactile.sessions`);
        const health = readLatestHealthObservation();
        const load = os.loadavg();
        return sendJson(res, 200, {
          success: true,
          checkedAt: databaseRows[0].checked_at,
          process: {
            status: "active",
            uptimeSeconds: Math.round(process.uptime()),
            memoryRssBytes: process.memoryUsage().rss,
            systemMemoryAvailableBytes: os.freemem(),
            load1m: load[0],
          },
          database: { status: "ok", bytes: Number(databaseRows[0].bytes) },
          services: health ? {
            api: health.api_service,
            postgres: health.postgres_service,
            caddy: health.caddy_service,
            backupLastResult: health.backup_last_result,
            lastObservedAt: health.timestamp_utc,
            apiHttpStatus: Number(health.api_http_status),
            apiSeconds: Number(health.api_seconds),
            diskUsedPercent: Number(health.disk_used_percent),
            errorsLastHour: Number(health.errors_last_hour),
            rxBytes: Number(health.rx_bytes),
            txBytes: Number(health.tx_bytes),
          } : null,
          records: { total: Number(sessionRows[0].total), created24h: Number(sessionRows[0].created_24h) },
          osm: {
            events24h: Number(osmRows[0].events_24h),
            succeeded24h: Number(osmRows[0].succeeded_24h),
            failed24h: Number(osmRows[0].failed_24h),
            blocked24h: Number(osmRows[0].blocked_24h),
            lastSuccessAt: osmRows[0].last_osm_success_at,
            merged: Number(linkRows[0].merged),
            reverted: Number(linkRows[0].reverted),
            conflicts: Number(linkRows[0].conflicts),
            failed: Number(linkRows[0].failed),
            alreadyPresent: Number(linkRows[0].already_present),
          },
        });
      }

      if (url.pathname.startsWith("/api/admin/tables/") && req.method === "GET") {
        const key = decodeURIComponent(url.pathname.slice("/api/admin/tables/".length));
        const config = TABLES[key];
        if (!config) return sendJson(res, 404, { error: "table_not_allowed" });
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 25));
        const [rows] = await pool.query(config.rows, [limit]);
        return sendJson(res, 200, { success: true, key, label: config.label, limit, rows });
      }

      if (url.pathname === "/api/admin/fitting-outliers" && req.method === "GET") {
        const [rows] = await pool.query(`SELECT source_session_digest,started_at,raw_point_count,difference_m,connected,
          browser_way_ids,valhalla_way_ids,raw_points,browser_paths,valhalla_paths
          FROM experiment.fitting_outlier_maps ORDER BY difference_m DESC,started_at DESC`);
        return sendJson(res, 200, { success: true, rows });
      }

      if (url.pathname === "/api/admin/experiments" && req.method === "GET") {
        const [rows] = await pool.query(
          "SELECT experiment_id,label,payload,created_by,created_at FROM experiment.api_records ORDER BY created_at DESC LIMIT 100"
        );
        return sendJson(res, 200, { success: true, rows });
      }

      if (url.pathname === "/api/admin/experiments" && req.method === "POST") {
        const body = await readJson(req);
        const label = String(body.label || "").trim().slice(0, 120);
        const payload = body.payload && typeof body.payload === "object" ? body.payload : null;
        if (!label || !payload) return sendJson(res, 400, { error: "invalid_experiment" });
        const experimentId = crypto.randomUUID();
        const payloadDigest = digest(payload);
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query(
            "INSERT INTO experiment.api_records(experiment_id,label,payload,created_by) VALUES(?,?,?::jsonb,?) RETURNING experiment_id",
            [experimentId, label, JSON.stringify(payload), req.authUserId]
          );
          await conn.query(
            "INSERT INTO experiment.api_record_audit(event_id,experiment_id,event_type,actor_user_id,payload_digest) VALUES(?,?,'created',?,?) RETURNING event_id",
            [crypto.randomUUID(), experimentId, req.authUserId, payloadDigest]
          );
          await conn.commit();
        } catch (insertError) {
          await conn.rollback();
          throw insertError;
        } finally { conn.release(); }
        return sendJson(res, 201, { success: true, experimentId, payloadDigest });
      }

      const deleteMatch = url.pathname.match(/^\/api\/admin\/experiments\/([0-9a-f-]+)$/i);
      if (deleteMatch && req.method === "DELETE") {
        const experimentId = deleteMatch[1];
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const [rows] = await conn.query(
            "SELECT payload FROM experiment.api_records WHERE experiment_id=? AND created_by=? LIMIT 1",
            [experimentId, req.authUserId]
          );
          if (!rows.length) {
            await conn.rollback();
            return sendJson(res, 404, { error: "experiment_not_found" });
          }
          const payloadDigest = digest(rows[0].payload);
          await conn.query("DELETE FROM experiment.api_records WHERE experiment_id=? AND created_by=?", [experimentId, req.authUserId]);
          await conn.query(
            "INSERT INTO experiment.api_record_audit(event_id,experiment_id,event_type,actor_user_id,payload_digest) VALUES(?,?,'deleted',?,?) RETURNING event_id",
            [crypto.randomUUID(), experimentId, req.authUserId, payloadDigest]
          );
          await conn.commit();
          return sendJson(res, 200, { success: true, experimentId, deleted: true, payloadDigest });
        } catch (deleteError) {
          await conn.rollback();
          throw deleteError;
        } finally { conn.release(); }
      }

      return sendJson(res, 404, { error: "not_found" });
    } catch (handlerError) {
      return sendJson(res, 500, { error: "admin_database_failed", message: handlerError.message });
    }
  };
}

module.exports = createAdminDatabaseHandler;
module.exports.readLatestHealthObservation = readLatestHealthObservation;
