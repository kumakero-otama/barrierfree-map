const crypto = require("crypto");
const { createDbPool } = require("../db");
const { fetchWalkableNetwork } = require("./osm_walkable");
const { replay, projectToSegment, inferWaySide } = require("../fitting/browser_matcher");
const { createSplitPlan } = require("../osm/split_planner");
const { ensureRecordLinkSchema } = require("../osm/record_links");
const { ensureReviewSchema, enqueueReview } = require("../osm/review_queue");

function readJson(req) {
  return new Promise((resolve, reject) => { let body = ""; req.on("data", (chunk) => { body += chunk; if (body.length > 32768) reject(new Error("payload_too_large")); });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("invalid_json")); } }); req.on("error", reject); });
}

function closestBoundary(point, way) {
  let best = null;
  for (let index = 0; index < way.coordinates.length - 1; index += 1) {
    const projected = projectToSegment(point, { lng: way.coordinates[index][0], lat: way.coordinates[index][1] },
      { lng: way.coordinates[index + 1][0], lat: way.coordinates[index + 1][1] });
    if (!best || projected.distance < best.distance) best = { kind: "projection", segmentIndex: index, fraction: projected.fraction,
      coordinate: [projected.lng, projected.lat], distance: projected.distance };
  }
  return best;
}

function createRecordReplayHandler({ sendJson }) {
  const { pool, error } = createDbPool();
  let ready;
  async function ensureSchema() {
    if (!ready) ready = (async () => {
      if (!pool) throw error || new Error("database_unavailable");
      await pool.query(`CREATE TABLE IF NOT EXISTS experiment.gps_replay_runs(
        replay_id uuid PRIMARY KEY,session_id uuid NOT NULL,requested_by text NOT NULL,event_count integer NOT NULL,
        historical_way_ids jsonb NOT NULL,replay_result jsonb NOT NULL,status text NOT NULL,osm_sent boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT NOW())`);
      await ensureRecordLinkSchema(pool);
      await ensureReviewSchema(pool);
    })().catch((schemaError) => { ready = null; throw schemaError; });
    return ready;
  }

  async function loadRecord(sessionId) {
    const [sessions] = await pool.query("SELECT session_id,user_id,started_at,ended_at FROM tactile.sessions WHERE session_id::text=? LIMIT 1", [sessionId]);
    if (!sessions[0]) throw new Error("recording_not_found");
    const [rows] = await pool.query(`SELECT ts,ST_Y(geom::geometry) lat,ST_X(geom::geometry) lng,accuracy
      FROM tactile.gps_raw WHERE session_id::text=? ORDER BY ts,id`, [sessionId]);
    const [edges] = await pool.query("SELECT seq,edge_id FROM tactile.session_path_edges WHERE session_id::text=? ORDER BY seq", [sessionId]);
    return { session: sessions[0], points: rows.map((row) => ({ ts: row.ts, lat: Number(row.lat), lng: Number(row.lng), accuracy: row.accuracy == null ? null : Number(row.accuracy) })),
      historicalWayIds: edges.map((edge) => Number(edge.edge_id)).filter(Number.isSafeInteger) };
  }

  return async function handle(req, res) {
    if (process.env.NODE_ENV !== "development") return sendJson(res, 404, { error: "not_found" });
    try {
      await ensureSchema();
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/api/admin/gps-replay" && req.method === "GET") {
        const [runs] = await pool.query("SELECT replay_id,session_id,event_count,historical_way_ids,replay_result,status,osm_sent,created_at FROM experiment.gps_replay_runs ORDER BY created_at DESC LIMIT 50");
        const [imports] = await pool.query(`SELECT i.development_session_id session_id,i.raw_point_count,i.matched_point_count,i.imported_at,
          ST_Length(p.geom)::numeric(12,2) path_m FROM experiment.production_record_imports i
          LEFT JOIN tactile.session_paths p ON p.session_id=i.development_session_id ORDER BY i.imported_at DESC`);
        return sendJson(res, 200, { success: true, runs, importedSessions: imports });
      }
      const body = await readJson(req);
      const sessionId = String(body.sessionId || "");
      const record = await loadRecord(sessionId);
      if (record.points.length < 2) return sendJson(res, 422, { error: "not_enough_gps_points" });
      const center = record.points.reduce((sum, point) => ({ lat: sum.lat + point.lat / record.points.length, lng: sum.lng + point.lng / record.points.length }), { lat: 0, lng: 0 });
      const network = await fetchWalkableNetwork(center.lat, center.lng, 1000);

      if (url.pathname === "/api/admin/gps-replay" && req.method === "POST") {
        const result = replay(record.points, network.ways);
        const events = record.points.map((point, index) => ({ sequence: index + 1, originalTimestamp: point.ts,
          originalDelayMs: index ? Math.max(0, new Date(point.ts) - new Date(record.points[index - 1].ts)) : 0,
          accuracy: point.accuracy, decision: result.matches[index] ? result.matches[index].inputQuality || "observed" : "discarded",
          selectedWayId: result.matches[index]?.wayId || null, historicalWayMatch: result.matches[index] ? record.historicalWayIds.includes(result.matches[index].wayId) : null,
          connectedToPrevious: result.matches[index]?.connectedToPrevious ?? null }));
        const matched = result.matches.filter(Boolean), agreement = matched.length ? matched.filter((match) => record.historicalWayIds.includes(match.wayId)).length / matched.length : 0;
        const replayResult = { ...result, events, historicalWayAgreement: agreement, finalRouteWayIds: result.wayIds,
          acceptance: { coverage: result.coverage >= .8, connected: result.connected, pedestrianPriority: result.missedPedestrianPriority === 0,
            discardedRatio: result.discardedPointCount / record.points.length <= .2 }, source: "production_readonly_copy", osmSent: false };
        const status = Object.values(replayResult.acceptance).every(Boolean) ? "pass" : "warning";
        const replayId = crypto.randomUUID();
        await pool.query(`INSERT INTO experiment.gps_replay_runs(replay_id,session_id,requested_by,event_count,historical_way_ids,replay_result,status,osm_sent)
          VALUES(?,?,?, ?,?::jsonb,?::jsonb,?,false) RETURNING replay_id`, [replayId, sessionId, req.authUserId, events.length,
          JSON.stringify(record.historicalWayIds), JSON.stringify(replayResult), status]);
        return sendJson(res, 201, { success: true, replayId, sessionId, status, rawPointCount: record.points.length,
          historicalWayIds: record.historicalWayIds, result: replayResult, osmSent: false });
      }

      if (url.pathname === "/api/admin/osm-preview-from-import" && req.method === "POST") {
        const wayId = Number(body.wayId || record.historicalWayIds[0]);
        const way = network.ways.find((item) => item.id === wayId);
        if (!way) return sendJson(res, 422, { error: "historical_way_not_found_in_current_osm", wayId, osmSent: false });
        const side = body.side === "left" || body.side === "right" ? body.side : inferWaySide(record.points, way);
        const independent = ["footway", "path", "pedestrian", "steps", "corridor"].includes(String(way.tags?.highway || "").toLowerCase()) || way.tags?.footway === "sidewalk";
        if (!independent && !side) return sendJson(res, 422, { error: "side_confirmation_required", allowed: ["left", "right"], osmSent: false });
        const from = closestBoundary(record.points[0], way), to = closestBoundary(record.points.at(-1), way);
        const segment = { wayId: way.id, wayVersion: way.version, nodes: way.nodes, fullCoordinates: way.coordinates, tags: way.tags,
          relations: way.relations || [], side, from, to };
        const splitPlan = createSplitPlan({ segments: [segment] }, { tactileValue: "yes" });
        const [existing] = await pool.query("SELECT merge_plan_id FROM osmchange.record_links WHERE record_id=? LIMIT 1", [sessionId]);
        if (existing[0]) {
          const [plans] = await pool.query("SELECT plan_id,summary,elements,client_context,created_at FROM osmchange.change_plans WHERE plan_id=? LIMIT 1", [existing[0].merge_plan_id]);
          return sendJson(res, 200, { success: true, reused: true, sessionId, planId: existing[0].merge_plan_id,
            plan: plans[0], side, segment, rawPoints: record.points.map((point) => [point.lat, point.lng]), splitPlan,
            boundaryDistancesMeters: { start: from.distance, end: to.distance }, osmSent: false });
        }
        const planId = crypto.randomUUID(), summary = "StepBy production READ ONLY copy: tactile paving preview (not sent)";
        const context = { previewOnly: true, osmWriteRequested: false, source: "production_readonly_copy", sessionId, side,
          boundaryDistancesMeters: { start: from.distance, end: to.distance }, splitSummary: splitPlan.summary };
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          await conn.query(`INSERT INTO osmchange.change_plans(plan_id,operation_type,created_by,source_plan_id,summary,elements,client_context)
            VALUES(?,'merge',?,NULL,?,?::jsonb,?::jsonb) RETURNING plan_id`, [planId, record.session.user_id, summary, JSON.stringify(splitPlan.operations), JSON.stringify(context)]);
          await conn.query("INSERT INTO osmchange.record_links(record_id,created_by,merge_plan_id,osm_status) VALUES(?,?,?,'draft') RETURNING record_id",
            [sessionId, record.session.user_id, planId]);
          await conn.query(`INSERT INTO osmchange.audit_events(plan_id,event_type,actor_user_id,request_id,details)
            VALUES(?,'split_plan_created',?,?,?::jsonb) RETURNING event_id`, [planId, record.session.user_id, req.securityRequestId || null,
            JSON.stringify({ ...splitPlan.summary, sessionId, source: "production_readonly_copy", previewOnly: true, osmSent: false })]);
          await enqueueReview(conn, { recordId: sessionId, planId, actorUserId: record.session.user_id,
            sourceType: "legacy_record", sourceRecordId: sessionId });
          await conn.commit();
        } catch (insertError) { await conn.rollback(); throw insertError; } finally { conn.release(); }
        return sendJson(res, 201, { success: true, reused: false, sessionId, planId, status: "pending_review", side, segment,
          rawPoints: record.points.map((point) => [point.lat, point.lng]),
          splitPlan, boundaryDistancesMeters: context.boundaryDistancesMeters, osmSent: false });
      }
      return sendJson(res, 404, { error: "not_found" });
    } catch (requestError) {
      console.error("[record_replay] failed", requestError.message);
      return sendJson(res, 500, { error: "record_replay_failed", message: requestError.message, osmSent: false });
    }
  };
}

module.exports = createRecordReplayHandler;
