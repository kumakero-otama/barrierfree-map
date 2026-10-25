const https = require("https");
const fs = require("fs");
const path = require("path");
const yaml = require("yaml");
const { createDbPool } = require("../db");
const { registerTactileTileMemoryInvalidator } = require("../osm/tactile_tile_invalidation");

const RULES_PATH = path.join(__dirname, "..", "..", "config", "osm_tactile_rules.yaml");
const OVERPASS_QUERY_TIMEOUT_SECONDS = 10;
const OVERPASS_REQUEST_TIMEOUT_MS = 12000;
const CACHE_FRESH_MS = 30 * 60 * 1000;
const CACHE_STALE_MS = 24 * 60 * 60 * 1000;
const HOST_FAILURE_COOLDOWN_MS = 2 * 60 * 1000;
const TACTILE_TILE_ZOOM = 15;
const MAX_TILES_PER_REQUEST = 9;
const TILE_CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
const TILE_CACHE_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const TILE_CACHE_UNUSED_RETENTION_DAYS = 90;
const TILE_CACHE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TILE_HTTP_WAIT_MS = 1800;
const TILE_FAILURE_COOLDOWN_MS = 30 * 1000;
const TILE_OVERPASS_QUERY_TIMEOUT_SECONDS = 4;
const TILE_OVERPASS_REQUEST_TIMEOUT_MS = 4500;
const TILE_BACKGROUND_QUEUE_LIMIT = 8;
const OVERPASS_MAX_CONCURRENCY = Math.max(1, Number.parseInt(process.env.OVERPASS_MAX_CONCURRENCY, 10) || 1);

// Web Mercatorの固定タイルIDを検証し、Overpassで使うbboxへ変換する。
function parseTileId(value) {
  const match = String(value || "").trim().match(/^(\d+)\/(\d+)\/(\d+)$/);
  if (!match) return null;
  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const limit = 2 ** z;
  if (z !== TACTILE_TILE_ZOOM || x < 0 || y < 0 || x >= limit || y >= limit) return null;
  const longitude = (tileX) => (tileX / limit) * 360 - 180;
  const latitude = (tileY) => Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / limit))) * 180 / Math.PI;
  return {
    id: `${z}/${x}/${y}`,
    z,
    x,
    y,
    bbox: {
      west: longitude(x),
      south: latitude(y + 1),
      east: longitude(x + 1),
      north: latitude(y),
    },
  };
}

function summarizeTileStatuses(responseTiles) {
  const successfulTileCount = responseTiles.filter((tile) => tile.status === "success" || tile.status === "empty").length;
  const pendingTileCount = responseTiles.filter((tile) => tile.status === "pending").length;
  const errorTileCount = responseTiles.filter((tile) => tile.status === "error").length;
  const unresolvedTileCount = pendingTileCount + errorTileCount;
  return {
    success: successfulTileCount > 0,
    partial: successfulTileCount > 0 && unresolvedTileCount > 0,
    pending: pendingTileCount > 0,
    allPending: pendingTileCount === responseTiles.length,
    allFailed: errorTileCount === responseTiles.length,
  };
}

// 正規表現で安全に扱えるよう、設定値のメタ文字をエスケープする。
function escapeRegexValue(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// YAML ルールを読み込み、利用可能な形式だけに正規化する。
function loadRules() {
  const raw = fs.readFileSync(RULES_PATH, "utf8");
  const parsed = yaml.parse(raw) || {};
  const displayRules = parsed.osm_tactile_display || {};
  const rawElementTypes = Array.isArray(displayRules.element_types)
    ? displayRules.element_types
    : typeof displayRules.element_type === "string"
      ? [displayRules.element_type]
      : [];
  const elementTypes = rawElementTypes.filter((value) => value === "way" || value === "node");
  const rawMatchers = Array.isArray(displayRules.matchers) ? displayRules.matchers : [];
  const matchers = rawMatchers
    .map((matcher) => {
      const key = matcher && typeof matcher.key === "string" ? matcher.key : "";
      const values = Array.isArray(matcher && matcher.values)
        ? matcher.values.filter((value) => typeof value === "string" && value.length > 0)
        : [];
      if (!key || values.length === 0) {
        return null;
      }
      return { key, values };
    })
    .filter(Boolean);

  if (elementTypes.length === 0) {
    throw new Error("invalid_element_types_in_osm_tactile_rules");
  }
  if (matchers.length === 0) {
    throw new Error("empty_matchers_in_osm_tactile_rules");
  }

  return {
    elementTypes,
    matchers,
  };
}

// ルールと中心点から Overpass QL クエリを組み立てる。
function buildOverpassQuery(centerLat, centerLng, radiusMeters, rules) {
  // 表示対象は tactile_paving の存在する地物に限定する。orientation等を個別検索すると
  // 同じ10km圏を何度も走査してOverpass負荷が大きくなるため、2 selectorへ集約する。
  const latDelta = radiusMeters / 111320;
  const lngDelta = radiusMeters / (111320 * Math.max(0.2, Math.cos(centerLat * Math.PI / 180)));
  return buildOverpassQueryForBbox({
    west: centerLng - lngDelta,
    south: centerLat - latDelta,
    east: centerLng + lngDelta,
    north: centerLat + latDelta,
  }, rules);
}

function buildOverpassQueryForBbox(bbox, rules, queryTimeoutSeconds = OVERPASS_QUERY_TIMEOUT_SECONDS) {
  const tactileRule = rules.matchers.find((matcher) => matcher.key === "tactile_paving");
  const valueRegex = (tactileRule ? tactileRule.values : ["yes", "both", "contrasted"])
    .map(escapeRegexValue).join("|");
  const bboxString = [bbox.south, bbox.west, bbox.north, bbox.east]
    .map((value) => Number(value).toFixed(7)).join(",");
  const selectors = rules.elementTypes
    .map((elementType) => `${elementType}["tactile_paving"~"^(${valueRegex})$"];`)
    .join("\n");
  return `
[out:json][timeout:${queryTimeoutSeconds}][bbox:${bboxString}];
(
${selectors}
);
out meta geom qt;
`;
}

// Overpass API へ POST して JSON レスポンスを受け取る。
function fetchOverpass(overpassHost, query, callback, requestTimeoutMs = OVERPASS_REQUEST_TIMEOUT_MS) {
  const body = `data=${encodeURIComponent(query)}`;
  let settled = false;
  let overallTimer = null;
  const finish = (error, payload) => {
    if (settled) return;
    settled = true;
    if (overallTimer) clearTimeout(overallTimer);
    callback(error, payload);
  };
  const options = {
    hostname: overpassHost,
    path: "/api/interpreter",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent": "barrierfree-map/1.27.3 (https://github.com/kumakero-otama/barrierfree-map)",
    },
  };

  const req = https.request(options, (res) => {
    let raw = "";
    res.on("data", (chunk) => {
      raw += chunk;
    });
    res.on("end", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        finish(new Error(`overpass_status_${res.statusCode || 0}`));
        return;
      }
      try {
        finish(null, JSON.parse(raw));
      } catch (err) {
        finish(new Error(`overpass_parse_error:${err.message}`));
      }
    });
    res.on("error", (error) => finish(new Error(`overpass_response_error:${error.message}`)));
  });

  // ソケット確立前のDNS・接続待ちも含む絶対期限を、request作成直後から計る。
  overallTimer = setTimeout(() => {
    const error = new Error("overpass_timeout");
    finish(error);
    req.destroy(error);
  }, requestTimeoutMs);
  req.setTimeout(requestTimeoutMs, () => req.destroy(new Error("overpass_timeout")));

  req.on("error", (err) => {
    finish(new Error(`overpass_request_error:${err.message}`));
  });
  req.write(body);
  req.end();
}

// Overpass の element 配列を地図表示しやすい GeoJSON へ変換する。
function toFeatureCollection(overpassJson, rules) {
  const elements = Array.isArray(overpassJson && overpassJson.elements) ? overpassJson.elements : [];
  const features = [];
  const isStepBy = (tags = {}) => Object.entries(tags).some(([key, value]) =>
    /stepby/i.test(String(key)) || /stepby/i.test(String(value))
  );

  elements.forEach((el) => {
    if (!el || !rules.elementTypes.includes(el.type)) {
      return;
    }
    const matched = rules.matchers.find((matcher) => {
      const tagValue = el.tags && typeof el.tags[matcher.key] === "string" ? el.tags[matcher.key] : "";
      return matcher.values.includes(tagValue);
    });
    if (!matched) {
      return;
    }
    const matchedValue = el.tags[matched.key];

    if (el.type === "way") {
      if (!Array.isArray(el.geometry) || el.geometry.length < 2) {
        return;
      }
      const coordinates = el.geometry
        .map((pt) => [Number(pt.lon), Number(pt.lat)])
        .filter(([lng, lat]) => Number.isFinite(lat) && Number.isFinite(lng));

      if (coordinates.length < 2) {
        return;
      }

      features.push({
        type: "Feature",
        properties: {
          osm_way_id: el.id,
          osm_type: "way",
          matched_tag_key: matched.key,
          matched_tag_value: matchedValue,
          osm_changeset_id: el.changeset == null ? null : Number(el.changeset),
          stepby_recorded: isStepBy(el.tags),
        },
        geometry: {
          type: "LineString",
          coordinates,
        },
      });
      return;
    }

    if (el.type === "node") {
      const lng = Number(el.lon);
      const lat = Number(el.lat);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return;
      }

      features.push({
        type: "Feature",
        properties: {
          osm_node_id: el.id,
          osm_type: "node",
          matched_tag_key: matched.key,
          matched_tag_value: matchedValue,
          osm_changeset_id: el.changeset == null ? null : Number(el.changeset),
          stepby_recorded: isStepBy(el.tags),
        },
        geometry: {
          type: "Point",
          coordinates: [lng, lat],
        },
      });
    }
  });

  return {
    type: "FeatureCollection",
    features,
  };
}

// 指定範囲の点字ブロック関連 OSM データを返す API ハンドラを生成する。
function createOsmTactileWaysHandler({ sendJson }) {
  const OVERPASS_HOSTS = [...new Set([
    process.env.OVERPASS_HOST,
    "overpass-api.de",
    "overpass.private.coffee",
  ].filter(Boolean))];
  const { pool } = createDbPool();
  const responseCache = new Map();
  const inFlightRequests = new Map();
  const hostFailures = new Map();
  const tileMemoryCache = new Map();
  const tileInFlightRequests = new Map();
  const tileFailures = new Map();
  const overpassQueue = [];
  let activeOverpassRequests = 0;
  let tileCacheSchemaReady = null;
  let tileCacheCleanupStarted = false;
  let rules;
  registerTactileTileMemoryInvalidator((tileIds) => {
    tileIds.forEach((tileId) => tileMemoryCache.delete(tileId));
  });
  try {
    rules = loadRules();
    console.log(
      `[osm_tactile] rules_loaded path=${RULES_PATH} element_types=${rules.elementTypes.join(",")} matchers=${rules.matchers.map((m) => `${m.key}=[${m.values.join(",")}]`).join(";")}`
    );
  } catch (err) {
    console.error("[osm_tactile] rules_load_error:", err.message);
    rules = null;
  }

  function ensureTileCacheSchema() {
    if (!pool) return Promise.reject(new Error("database_unavailable"));
    if (!tileCacheSchemaReady) {
      tileCacheSchemaReady = (async () => {
        await pool.query("CREATE SCHEMA IF NOT EXISTS osmcache");
        await pool.query(`CREATE TABLE IF NOT EXISTS osmcache.tactile_tiles (
          tile_id TEXT PRIMARY KEY,
          zoom SMALLINT NOT NULL,
          tile_x INTEGER NOT NULL,
          tile_y INTEGER NOT NULL,
          fetched_at TIMESTAMPTZ NOT NULL,
          last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
          osm_base_at TIMESTAMPTZ,
          status TEXT NOT NULL CHECK (status IN ('success','empty')),
          features JSONB NOT NULL DEFAULT '[]'::jsonb,
          feature_count INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        await pool.query("CREATE INDEX IF NOT EXISTS tactile_tiles_last_accessed_idx ON osmcache.tactile_tiles(last_accessed_at)");
      })().catch((error) => {
        tileCacheSchemaReady = null;
        throw error;
      });
    }
    return tileCacheSchemaReady;
  }

  // 90日間参照されていないタイルを削除する。API応答を待たせず、失敗しても
  // メモリキャッシュと読取APIは継続する。
  async function cleanupUnusedTileCache() {
    try {
      await ensureTileCacheSchema();
      await pool.query(
        `DELETE FROM osmcache.tactile_tiles
          WHERE last_accessed_at < CURRENT_TIMESTAMP - INTERVAL '${TILE_CACHE_UNUSED_RETENTION_DAYS} days'`
      );
    } catch (error) {
      console.warn("[osm_tactile_tiles] cache cleanup skipped:", error.message);
    }
  }

  function startTileCacheCleanup() {
    if (tileCacheCleanupStarted) return;
    tileCacheCleanupStarted = true;
    // 起動直後も非同期で一度実行し、その後は一定間隔で整理する。
    setTimeout(() => cleanupUnusedTileCache(), 0).unref?.();
    const timer = setInterval(() => cleanupUnusedTileCache(), TILE_CACHE_CLEANUP_INTERVAL_MS);
    timer.unref?.();
  }

  // 公開Overpassへの実行数をサーバー全体で絞り、429や共有サーバーへの負荷を抑える。
  function withOverpassSlot(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        activeOverpassRequests += 1;
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
          activeOverpassRequests -= 1;
          const next = overpassQueue.shift();
          if (next) next();
        });
      };
      if (activeOverpassRequests < OVERPASS_MAX_CONCURRENCY) run();
      else overpassQueue.push(run);
    });
  }

  function fetchOverpassFromHosts(query, requestTimeoutMs = OVERPASS_REQUEST_TIMEOUT_MS) {
    return withOverpassSlot(() => new Promise((resolve, reject) => {
      const now = Date.now();
      const hosts = OVERPASS_HOSTS.filter((host) => now - (hostFailures.get(host) || 0) >= HOST_FAILURE_COOLDOWN_MS);
      if (hosts.length === 0) {
        reject(new Error("all_overpass_hosts_cooling_down"));
        return;
      }
      const tryHost = (index) => {
        if (index >= hosts.length) {
          reject(new Error("all_overpass_hosts_failed"));
          return;
        }
        const host = hosts[index];
        const hostStartedAt = Date.now();
        fetchOverpass(host, query, (error, payload) => {
          const elapsedMs = Date.now() - hostStartedAt;
          if (error) {
            hostFailures.set(host, Date.now());
            console.warn(`[osm_tactile] host failed ${host} elapsedMs=${elapsedMs} timeoutMs=${requestTimeoutMs}:`, error.message);
            tryHost(index + 1);
            return;
          }
          hostFailures.delete(host);
          console.info(`[osm_tactile] host completed ${host} elapsedMs=${elapsedMs} timeoutMs=${requestTimeoutMs}`);
          resolve(payload);
        }, requestTimeoutMs);
      };
      tryHost(0);
    }));
  }

  async function addStepByOwnership(basePayload, userId, searchArea = {}) {
    const payload = JSON.parse(JSON.stringify(basePayload));
    if (!pool || !Array.isArray(payload.features)) return payload;
    const changesetIds = [...new Set(payload.features
      .map((feature) => feature.properties && feature.properties.osm_changeset_id)
      .filter(Number.isFinite))];
    let rows = [];
    if (changesetIds.length) {
      const placeholders = changesetIds.map(() => "?").join(",");
      [rows] = await pool.query(
        `SELECT record_id,created_by,merge_changeset_id,osm_status FROM osmchange.record_links
         WHERE merge_changeset_id IN (${placeholders})
           AND EXISTS (
             SELECT 1 FROM osmchange.audit_events ae
              WHERE ae.plan_id=osmchange.record_links.merge_plan_id
                AND ae.event_type='execution_succeeded'
                AND ae.details->>'osmApiBaseUrl'=?
           )`, [...changesetIds, process.env.OSM_API_BASE_URL || ""]
      );
    }
    const recordsByChangeset = new Map(rows.map((row) => [Number(row.merge_changeset_id), row]));
    payload.features.forEach((feature) => {
      const properties = feature.properties || (feature.properties = {});
      const record = recordsByChangeset.get(Number(properties.osm_changeset_id));
      if (!record) return;
      properties.stepby_recorded = true;
      properties.stepby_record_id = String(record.record_id);
      properties.stepby_owner_user_id = Number(record.created_by);
      if (["merged", "revert_draft", "failed"].includes(record.osm_status) && String(record.created_by) === String(userId)) {
        properties.stepby_owned_record_id = String(record.record_id);
        properties.stepby_can_revert = true;
      }
    });

    // OSM開発環境には公開Overpassと同等の読取基盤がないため、送信済みの
    // StepBy記録を開発DBの確定経路から補完する。これにより、保存後に緑線を
    // 選択して、同じUIから取り消し操作まで行える。
    const centerLat = Number(searchArea.centerLat);
    const centerLng = Number(searchArea.centerLng);
    const radiusMeters = Number(searchArea.radiusMeters);
    if (Number.isFinite(centerLat) && Number.isFinite(centerLng) && Number.isFinite(radiusMeters) && radiusMeters > 0) {
      const [linkedPaths] = await pool.query(
        `SELECT l.record_id,l.created_by,l.merge_changeset_id,l.osm_status,
                ST_AsGeoJSON(sp.geom) AS geom_geojson
           FROM osmchange.record_links l
           JOIN tactile.session_paths sp ON sp.session_id=l.record_id
           JOIN tactile.sessions s ON s.session_id=l.record_id
          WHERE l.osm_status IN ('merged','revert_draft')
            AND s.is_active=TRUE
            AND EXISTS (
              SELECT 1 FROM osmchange.audit_events ae
               WHERE ae.plan_id=l.merge_plan_id
                 AND ae.event_type='execution_succeeded'
                 AND ae.details->>'osmApiBaseUrl'=?
            )
            AND ST_DWithin(
              sp.geom,
              ST_SetSRID(ST_MakePoint(?, ?),4326)::geography,
              ?
            )`,
        [process.env.OSM_API_BASE_URL || "", centerLng, centerLat, radiusMeters]
      );
      const representedChangesets = new Set(payload.features
        .map((feature) => Number(feature.properties && feature.properties.osm_changeset_id))
        .filter(Number.isFinite));
      linkedPaths.forEach((record) => {
        const changesetId = Number(record.merge_changeset_id);
        if (representedChangesets.has(changesetId)) return;
        let geometry;
        try {
          geometry = typeof record.geom_geojson === "string"
            ? JSON.parse(record.geom_geojson)
            : record.geom_geojson;
        } catch (_) {
          return;
        }
        if (!geometry) return;
        const owned = String(record.created_by) === String(userId);
        payload.features.push({
          type: "Feature",
          properties: {
            osm_type: "stepby_record",
            osm_id: null,
            osm_changeset_id: changesetId,
            stepby_recorded: true,
            stepby_record_id: String(record.record_id),
            stepby_owner_user_id: Number(record.created_by),
            stepby_owned_record_id: owned ? String(record.record_id) : undefined,
            stepby_can_revert: owned,
            source: "stepby_development_record",
          },
          geometry,
        });
      });
    }
    payload.count = payload.features.length;
    return payload;
  }

  async function readTileCache(tile) {
    const memory = tileMemoryCache.get(tile.id);
    if (memory) {
      // メモリヒットでもDB上の最終参照日時を更新し、利用中タイルの誤削除を防ぐ。
      ensureTileCacheSchema()
        .then(() => pool.query("UPDATE osmcache.tactile_tiles SET last_accessed_at=CURRENT_TIMESTAMP WHERE tile_id=?", [tile.id]))
        .catch((error) => console.warn("[osm_tactile_tiles] last_access update skipped:", error.message));
      return { entry: memory, source: "memory" };
    }
    try {
      await ensureTileCacheSchema();
      const [rows] = await pool.query(
        `SELECT tile_id,fetched_at,osm_base_at,status,features,feature_count
           FROM osmcache.tactile_tiles WHERE tile_id=?`,
        [tile.id]
      );
      if (!rows.length) return { entry: null, source: "miss" };
      const row = rows[0];
      const entry = {
        savedAt: new Date(row.fetched_at).getTime(),
        osmBaseAt: row.osm_base_at ? new Date(row.osm_base_at).toISOString() : null,
        status: row.status,
        features: Array.isArray(row.features) ? row.features : [],
      };
      tileMemoryCache.set(tile.id, entry);
      pool.query("UPDATE osmcache.tactile_tiles SET last_accessed_at=CURRENT_TIMESTAMP WHERE tile_id=?", [tile.id])
        .catch((error) => console.warn("[osm_tactile_tiles] last_access update skipped:", error.message));
      return { entry, source: "db" };
    } catch (error) {
      console.warn("[osm_tactile_tiles] persistent cache read skipped:", error.message);
      return { entry: memory || null, source: memory ? "memory" : "miss" };
    }
  }

  async function writeTileCache(tile, entry) {
    tileMemoryCache.set(tile.id, entry);
    try {
      await ensureTileCacheSchema();
      await pool.query(
        `INSERT INTO osmcache.tactile_tiles
           (tile_id,zoom,tile_x,tile_y,fetched_at,last_accessed_at,osm_base_at,status,features,feature_count,updated_at)
         VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,?,?,?::jsonb,?,CURRENT_TIMESTAMP)
         ON CONFLICT (tile_id) DO UPDATE SET
           fetched_at=EXCLUDED.fetched_at,
           last_accessed_at=EXCLUDED.last_accessed_at,
           osm_base_at=EXCLUDED.osm_base_at,
           status=EXCLUDED.status,
           features=EXCLUDED.features,
           feature_count=EXCLUDED.feature_count,
           updated_at=CURRENT_TIMESTAMP
         RETURNING tile_id`,
        [tile.id, tile.z, tile.x, tile.y, entry.osmBaseAt, entry.status, JSON.stringify(entry.features), entry.features.length]
      );
    } catch (error) {
      // DBキャッシュが利用できなくても、メモリキャッシュと読取APIは継続する。
      console.warn("[osm_tactile_tiles] persistent cache write skipped:", error.message);
    }
  }

  function refreshTile(tile) {
    let inFlight = tileInFlightRequests.get(tile.id);
    if (inFlight) return inFlight;
    const startedAt = Date.now();
    const queueDepthAtStart = overpassQueue.length + activeOverpassRequests;
    inFlight = (async () => {
      const query = buildOverpassQueryForBbox(tile.bbox, rules, TILE_OVERPASS_QUERY_TIMEOUT_SECONDS);
      const overpassJson = await fetchOverpassFromHosts(query, TILE_OVERPASS_REQUEST_TIMEOUT_MS);
      const features = toFeatureCollection(overpassJson, rules).features;
      const osmBaseRaw = overpassJson && overpassJson.osm3s && overpassJson.osm3s.timestamp_osm_base;
      const entry = {
        savedAt: Date.now(),
        osmBaseAt: osmBaseRaw && !Number.isNaN(Date.parse(osmBaseRaw)) ? new Date(osmBaseRaw).toISOString() : null,
        status: features.length ? "success" : "empty",
        features,
      };
      await writeTileCache(tile, entry);
      tileFailures.delete(tile.id);
      return entry;
    })().catch((error) => {
      tileFailures.set(tile.id, { failedAt: Date.now(), error: error.message || "osm_upstream_error" });
      throw error;
    }).finally(() => tileInFlightRequests.delete(tile.id));
    inFlight.startedAt = startedAt;
    inFlight.queueDepthAtStart = queueDepthAtStart;
    tileInFlightRequests.set(tile.id, inFlight);
    return inFlight;
  }

  function waitForRefresh(inFlight) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ state: "pending" }), TILE_HTTP_WAIT_MS);
      inFlight.then(
        (entry) => finish({ state: "success", entry }),
        (error) => finish({ state: "error", error })
      );
    });
  }

  async function resolveTile(tile) {
    const cacheResult = await readTileCache(tile);
    const cached = cacheResult.entry;
    const ageMs = cached ? Date.now() - cached.savedAt : Infinity;
    if (cached && ageMs < TILE_CACHE_FRESH_MS) {
      return { tile, entry: cached, cached: true, stale: false, source: cacheResult.source, overpassWaitMs: 0, queueDepth: 0 };
    }
    if (cached) {
      if (tileInFlightRequests.has(tile.id) || tileInFlightRequests.size < TILE_BACKGROUND_QUEUE_LIMIT) {
        refreshTile(tile).catch((error) => console.warn(`[osm_tactile_tiles] refresh failed ${tile.id}:`, error.message));
      }
      return { tile, entry: cached, cached: true, stale: true, source: "stale", overpassWaitMs: 0, queueDepth: overpassQueue.length };
    }

    const previousFailure = tileFailures.get(tile.id);
    const failureAgeMs = previousFailure ? Date.now() - previousFailure.failedAt : Infinity;
    if (previousFailure && failureAgeMs < TILE_FAILURE_COOLDOWN_MS) {
      return {
        tile,
        error: previousFailure.error,
        retryAfterMs: TILE_FAILURE_COOLDOWN_MS - failureAgeMs,
        source: "error",
        overpassWaitMs: 0,
        queueDepth: overpassQueue.length,
      };
    }

    let inFlight = tileInFlightRequests.get(tile.id);
    if (!inFlight && tileInFlightRequests.size >= TILE_BACKGROUND_QUEUE_LIMIT) {
      return {
        tile,
        pending: true,
        retryAfterMs: 2000,
        source: "pending",
        overpassWaitMs: 0,
        queueDepth: tileInFlightRequests.size,
      };
    }
    inFlight = inFlight || refreshTile(tile);
    const waited = await waitForRefresh(inFlight);
    const overpassWaitMs = Date.now() - inFlight.startedAt;
    if (waited.state === "success") {
      return { tile, entry: waited.entry, cached: false, stale: false, source: "fresh", overpassWaitMs, queueDepth: inFlight.queueDepthAtStart };
    }
    if (waited.state === "error") {
      return {
        tile,
        error: waited.error.message || "osm_upstream_error",
        retryAfterMs: TILE_FAILURE_COOLDOWN_MS,
        source: "error",
        overpassWaitMs,
        queueDepth: inFlight.queueDepthAtStart,
      };
    }
    return {
      tile,
      pending: true,
      retryAfterMs: 2000,
      source: "pending",
      overpassWaitMs,
      queueDepth: inFlight.queueDepthAtStart,
    };
  }

  async function handleOsmTactileTiles(req, res, url) {
    const responseStartedAt = Date.now();
    startTileCacheCleanup();
    const requested = String(url.searchParams.get("tiles") || "").split(",").map((value) => value.trim()).filter(Boolean);
    const unique = [...new Set(requested)];
    if (!unique.length || unique.length > MAX_TILES_PER_REQUEST) {
      sendJson(res, 400, { error: "invalid_tile_count", maxTiles: MAX_TILES_PER_REQUEST });
      return;
    }
    const tiles = unique.map(parseTileId);
    if (tiles.some((tile) => !tile)) {
      sendJson(res, 400, { error: "invalid_tile_id", requiredZoom: TACTILE_TILE_ZOOM });
      return;
    }

    const resolved = await Promise.all(tiles.map(resolveTile));
    const publicFeatures = [];
    const seen = new Set();
    resolved.forEach((result) => {
      if (!result.entry) return;
      result.entry.features.forEach((feature) => {
        const properties = feature.properties || {};
        const id = `${properties.osm_type || feature.geometry?.type}:${properties.osm_way_id || properties.osm_node_id || properties.osm_id || ""}`;
        if (!seen.has(id)) {
          seen.add(id);
          publicFeatures.push(feature);
        }
      });
    });
    let enrichedById = new Map();
    try {
      const enriched = await addStepByOwnership({ features: publicFeatures }, req.authUserId);
      enrichedById = new Map(enriched.features.map((feature) => {
        const properties = feature.properties || {};
        return [`${properties.osm_type || feature.geometry?.type}:${properties.osm_way_id || properties.osm_node_id || properties.osm_id || ""}`, feature];
      }));
    } catch (error) {
      console.warn("[osm_tactile_tiles] ownership lookup skipped:", error.message);
    }
    const responseTiles = resolved.map((result) => {
      if (result.pending) return { tileId: result.tile.id, status: "pending", retryAfterMs: result.retryAfterMs, features: [] };
      if (!result.entry) return { tileId: result.tile.id, status: "error", error: result.error || "osm_upstream_error", retryAfterMs: result.retryAfterMs, features: [] };
      return {
        tileId: result.tile.id,
        status: result.entry.status,
        fetchedAt: new Date(result.entry.savedAt).toISOString(),
        osmBaseAt: result.entry.osmBaseAt,
        cached: result.cached,
        stale: result.stale,
        features: result.entry.features.map((feature) => {
          const properties = feature.properties || {};
          const id = `${properties.osm_type || feature.geometry?.type}:${properties.osm_way_id || properties.osm_node_id || properties.osm_id || ""}`;
          return enrichedById.get(id) || feature;
        }),
      };
    });
    const responseMs = Date.now() - responseStartedAt;
    resolved.forEach((result) => {
      console.info(
        `[osm_tactile_tiles] tile_response tileId=${result.tile.id} source=${result.source} ` +
        `responseMs=${responseMs} overpassWaitMs=${result.overpassWaitMs || 0} queueDepth=${result.queueDepth || 0}`
      );
    });
    const statusSummary = summarizeTileStatuses(responseTiles);
    sendJson(res, 200, {
      ...statusSummary,
      zoom: TACTILE_TILE_ZOOM,
      tiles: responseTiles,
    });
  }

  // 指定範囲の点字ブロック関連データをOverpass経由で返す。
  return function handleOsmTactileWays(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    try {
      if (!rules) {
        sendJson(res, 500, { error: "osm_tactile_rules_unavailable" });
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/api/osm-tactile-tiles") {
        handleOsmTactileTiles(req, res, url).catch((error) => {
          console.error("[osm_tactile_tiles] handler error:", error.message);
          if (!res.headersSent) sendJson(res, 500, { error: "osm_tactile_tile_handler_error" });
        });
        return;
      }
      const centerLat = Number(url.searchParams.get("centerLat"));
      const centerLng = Number(url.searchParams.get("centerLng"));
      const radiusKmRaw = Number(url.searchParams.get("radiusKm"));
      const radiusKm = Number.isFinite(radiusKmRaw) && radiusKmRaw > 0 ? radiusKmRaw : 10;
      // 表示専用レイヤー。フィッティング用1km道路網とは分離し、最大10kmまで許可する。
      const radiusMeters = Math.round(Math.min(radiusKm, 10) * 1000);

      if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng)) {
        sendJson(res, 400, { error: "invalid_center" });
        return;
      }

      const query = buildOverpassQuery(centerLat, centerLng, radiusMeters, rules);
      const cacheKey = `${centerLat.toFixed(2)}:${centerLng.toFixed(2)}:${radiusMeters}`;
      const cached = responseCache.get(cacheKey);
      const cacheAgeMs = cached ? Date.now() - cached.savedAt : Infinity;
      if (cached && cacheAgeMs < CACHE_FRESH_MS) {
        addStepByOwnership({ ...cached.payload, cached: true }, req.authUserId, { centerLat, centerLng, radiusMeters })
          .then((payload) => sendJson(res, 200, payload))
          .catch((dbError) => {
            console.warn("[osm_tactile] StepBy ownership lookup skipped:", dbError.message);
            sendJson(res, 200, { ...cached.payload, cached: true });
          });
        return;
      }

      // Overpassが一時的に混雑していても、過去24時間以内の表示データがあれば即座に返す。
      // バックグラウンド更新は同じ検索範囲につき1本だけにまとめる。
      const servePayload = (basePayload, cachedValue) => {
        addStepByOwnership({ ...basePayload, cached: cachedValue }, req.authUserId, { centerLat, centerLng, radiusMeters })
          .then((payload) => sendJson(res, 200, payload))
          .catch((dbError) => {
            console.warn("[osm_tactile] StepBy ownership lookup skipped:", dbError.message);
            sendJson(res, 200, { ...basePayload, cached: cachedValue });
          });
      };

      const fetchAndCache = () => fetchOverpassFromHosts(query).then((overpassJson) => {
        // レスポンスは FeatureCollection ではなく features 配列中心で返し、既存フロント構造に合わせる。
        const featureCollection = toFeatureCollection(overpassJson, rules);
        const basePayload = {
          success: true,
          centerLat,
          centerLng,
          radiusKm: radiusMeters / 1000,
          count: featureCollection.features.length,
          features: featureCollection.features,
          cached: false,
        };
        responseCache.set(cacheKey, { savedAt: Date.now(), payload: basePayload });
        return basePayload;
      });

      let inFlight = inFlightRequests.get(cacheKey);
      if (!inFlight) {
        inFlight = fetchAndCache().finally(() => inFlightRequests.delete(cacheKey));
        inFlightRequests.set(cacheKey, inFlight);
      }

      if (cached && cacheAgeMs < CACHE_STALE_MS) {
        // stale-while-revalidate: 表示を待たせず、更新結果は次回以降に利用する。
        inFlight.catch((error) => console.warn("[osm_tactile] background refresh failed:", error.message));
        servePayload(cached.payload, true);
        return;
      }

      inFlight.then((basePayload) => servePayload(basePayload, false)).catch(async () => {
        try {
          const fallbackPayload = await addStepByOwnership({
            success: true,
            centerLat,
            centerLng,
            radiusKm: radiusMeters / 1000,
            count: 0,
            features: [],
            cached: false,
            osmUpstreamUnavailable: true,
          }, req.authUserId, { centerLat, centerLng, radiusMeters });
          if (fallbackPayload.features.length) {
            sendJson(res, 200, fallbackPayload);
            return;
          }
        } catch (dbError) {
          console.warn("[osm_tactile] StepBy fallback lookup failed:", dbError.message);
        }
        sendJson(res, 502, { error: "osm_upstream_error", message: "all_overpass_hosts_failed" });
      });
    } catch (err) {
      console.error("[osm_tactile] handler error:", err.message);
      sendJson(res, 500, { error: "osm_tactile_handler_error", message: err.message });
    }
  };
}

module.exports = createOsmTactileWaysHandler;
module.exports.parseTileId = parseTileId;
module.exports.buildOverpassQueryForBbox = buildOverpassQueryForBbox;
module.exports.TACTILE_TILE_ZOOM = TACTILE_TILE_ZOOM;
module.exports.summarizeTileStatuses = summarizeTileStatuses;
module.exports.fetchOverpass = fetchOverpass;
