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
        sendJson(res, 200, { ...cached.payload, cached: true });
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
          sendJson(res, 502, { error: "osm_upstream_error", message: "all_overpass_hosts_failed" });
          return;
        }
        // レスポンスは FeatureCollection ではなく features 配列中心で返し、既存フロント構造に合わせる。
        const featureCollection = toFeatureCollection(overpassJson, rules);
        if (pool && featureCollection.features.length) {
          const changesetIds = [...new Set(featureCollection.features
            .map((feature) => feature.properties.osm_changeset_id)
            .filter(Number.isFinite))];
          if (changesetIds.length) {
            try {
              const placeholders = changesetIds.map(() => "?").join(",");
              const [rows] = await pool.query(
                `SELECT merge_changeset_id FROM osmchange.record_links
                 WHERE osm_status='merged' AND merge_changeset_id IN (${placeholders})`,
                changesetIds
              );
              const known = new Set(rows.map((row) => Number(row.merge_changeset_id)));
              featureCollection.features.forEach((feature) => {
                if (known.has(feature.properties.osm_changeset_id)) feature.properties.stepby_recorded = true;
              });
            } catch (dbError) {
              console.warn("[osm_tactile] StepBy changeset lookup skipped:", dbError.message);
            }
          }
        }
        const responsePayload = {
          success: true,
          centerLat,
          centerLng,
          radiusKm: radiusMeters / 1000,
          count: featureCollection.features.length,
          features: featureCollection.features,
          cached: false,
        };
        responseCache.set(cacheKey, { savedAt: Date.now(), payload: responsePayload });
        sendJson(res, 200, responsePayload);
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
