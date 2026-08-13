const https = require("https");
const fs = require("fs");
const path = require("path");
const yaml = require("yaml");
const { createDbPool } = require("../db");

const RULES_PATH = path.join(__dirname, "..", "..", "config", "osm_tactile_rules.yaml");

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
  const tactileRule = rules.matchers.find((matcher) => matcher.key === "tactile_paving");
  const valueRegex = (tactileRule ? tactileRule.values : ["yes", "both", "contrasted"])
    .map(escapeRegexValue).join("|");
  const latDelta = radiusMeters / 111320;
  const lngDelta = radiusMeters / (111320 * Math.max(0.2, Math.cos(centerLat * Math.PI / 180)));
  const bbox = [centerLat - latDelta, centerLng - lngDelta, centerLat + latDelta, centerLng + lngDelta]
    .map((value) => value.toFixed(7)).join(",");
  const selectors = rules.elementTypes
    .map((elementType) => `${elementType}["tactile_paving"~"^(${valueRegex})$"](${bbox});`)
    .join("\n");
  return `
[out:json][timeout:25];
(
${selectors}
);
out meta geom;
`;
}

// Overpass API へ POST して JSON レスポンスを受け取る。
function fetchOverpass(overpassHost, query, callback) {
  const body = `data=${encodeURIComponent(query)}`;
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
        callback(new Error(`overpass_status_${res.statusCode || 0}`));
        return;
      }
      try {
        callback(null, JSON.parse(raw));
      } catch (err) {
        callback(new Error(`overpass_parse_error:${err.message}`));
      }
    });
  });

  req.setTimeout(30000, () => req.destroy(new Error("overpass_timeout")));

  req.on("error", (err) => {
    callback(new Error(`overpass_request_error:${err.message}`));
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
    "overpass.kumi.systems",
    "overpass.private.coffee",
  ].filter(Boolean))];
  const { pool } = createDbPool();
  const responseCache = new Map();
  let rules;
  try {
    rules = loadRules();
    console.log(
      `[osm_tactile] rules_loaded path=${RULES_PATH} element_types=${rules.elementTypes.join(",")} matchers=${rules.matchers.map((m) => `${m.key}=[${m.values.join(",")}]`).join(";")}`
    );
  } catch (err) {
    console.error("[osm_tactile] rules_load_error:", err.message);
    rules = null;
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
      if (cached && Date.now() - cached.savedAt < 5 * 60 * 1000) {
        addStepByOwnership({ ...cached.payload, cached: true }, req.authUserId, { centerLat, centerLng, radiusMeters })
          .then((payload) => sendJson(res, 200, payload))
          .catch((dbError) => {
            console.warn("[osm_tactile] StepBy ownership lookup skipped:", dbError.message);
            sendJson(res, 200, { ...cached.payload, cached: true });
          });
        return;
      }
      const tryHost = (index) => {
        fetchOverpass(OVERPASS_HOSTS[index], query, async (err, overpassJson) => {
        if (err) {
          console.warn(`[osm_tactile] host failed ${OVERPASS_HOSTS[index]}:`, err.message);
          if (index + 1 < OVERPASS_HOSTS.length) {
            tryHost(index + 1);
            return;
          }
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
            // StepByの送信済み経路だけでも返せる場合は、取消し操作を継続可能にする。
            if (fallbackPayload.features.length) {
              sendJson(res, 200, fallbackPayload);
              return;
            }
          } catch (dbError) {
            console.warn("[osm_tactile] StepBy fallback lookup failed:", dbError.message);
          }
          sendJson(res, 502, { error: "osm_upstream_error", message: "all_overpass_hosts_failed" });
          return;
        }
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
        try {
          sendJson(res, 200, await addStepByOwnership(basePayload, req.authUserId, { centerLat, centerLng, radiusMeters }));
        } catch (dbError) {
          console.warn("[osm_tactile] StepBy ownership lookup skipped:", dbError.message);
          sendJson(res, 200, basePayload);
        }
      });
      };
      tryHost(0);
    } catch (err) {
      console.error("[osm_tactile] handler error:", err.message);
      sendJson(res, 500, { error: "osm_tactile_handler_error", message: err.message });
    }
  };
}

module.exports = createOsmTactileWaysHandler;
