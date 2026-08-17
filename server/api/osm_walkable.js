const https = require("https");

const DEFAULT_RADIUS_METERS = 1000;
const MAX_RADIUS_METERS = 1500;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function clearWalkableNetworkCache() {
  const clearedEntries = cache.size;
  cache.clear();
  return clearedEntries;
}

function buildQuery(lat, lng, radiusMeters) {
  return `[out:json][timeout:25];
way(around:${radiusMeters},${lat},${lng})
  ["highway"]
  ["highway"!~"^(motorway|motorway_link|trunk|trunk_link|raceway|construction|proposed)$"]
  ["access"!~"^(private|no)$"]->.walkable;
(.walkable; relation(bw.walkable););
out meta geom;`;
}

function fetchOverpass(host, query, callback) {
  const body = `data=${encodeURIComponent(query)}`;
  const req = https.request(
    {
      hostname: host,
      path: "/api/interpreter",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "StepBy-dev/1.0 (https://github.com/kumakero-otama/barrierfree-map)",
      },
    },
    (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
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
    }
  );
  req.setTimeout(30000, () => req.destroy(new Error("overpass_timeout")));
  req.on("error", (err) => callback(new Error(`overpass_request_error:${err.message}`)));
  req.write(body);
  req.end();
}

function bboxForRadius(lat, lng, radiusMeters) {
  const latDelta = radiusMeters / 111320;
  const lngDelta = radiusMeters / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return [lng - lngDelta, lat - latDelta, lng + lngDelta, lat + latDelta]
    .map((value) => value.toFixed(7)).join(",");
}

// Overpass が混雑・停止している場合にも記録を止めないため、OSM本体の読取APIから
// 1km圏のNode/Wayを取得する。これは読取り専用で、OSMへの変更は一切行わない。
function fetchOsmMap(lat, lng, radiusMeters, callback) {
  const bbox = bboxForRadius(lat, lng, radiusMeters);
  const req = https.request({
    hostname: "api.openstreetmap.org",
    path: `/api/0.6/map?bbox=${encodeURIComponent(bbox)}`,
    method: "GET",
    headers: { "User-Agent": "StepBy-dev/1.0 (https://github.com/kumakero-otama/barrierfree-map)" },
  }, (res) => {
    let raw = "";
    res.on("data", (chunk) => { raw += chunk; });
    res.on("end", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return callback(new Error(`osm_map_status_${res.statusCode || 0}`));
      try { callback(null, normalizeOsmXml(raw)); } catch (error) { callback(error); }
    });
  });
  req.setTimeout(30000, () => req.destroy(new Error("osm_map_timeout")));
  req.on("error", callback);
  req.end();
}

function xmlAttr(source, name) {
  const match = source.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "";
}

function normalizeOsmXml(xml) {
  const nodes = new Map();
  for (const match of xml.matchAll(/<node\b([^>]*?)(?:\/>|>[\s\S]*?<\/node>)/g)) {
    const id = Number(xmlAttr(match[1], "id"));
    const lat = Number(xmlAttr(match[1], "lat"));
    const lon = Number(xmlAttr(match[1], "lon"));
    if (Number.isSafeInteger(id) && Number.isFinite(lat) && Number.isFinite(lon)) nodes.set(id, { lat, lon });
  }
  const ways = [];
  for (const match of xml.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)) {
    const attrs = match[1], body = match[2];
    const tags = {};
    for (const tag of body.matchAll(/<tag\b([^>]*)\/>/g)) tags[xmlAttr(tag[1], "k")] = xmlAttr(tag[1], "v");
    const highway = String(tags.highway || "");
    if (!highway || /^(motorway|motorway_link|trunk|trunk_link|raceway|construction|proposed)$/.test(highway) || /^(private|no)$/.test(String(tags.access || ""))) continue;
    const nodeIds = Array.from(body.matchAll(/<nd\b([^>]*)\/>/g), (nd) => Number(xmlAttr(nd[1], "ref"))).filter(Number.isSafeInteger);
    const geometry = nodeIds.map((id) => nodes.get(id)).filter(Boolean);
    if (geometry.length < 2) continue;
    ways.push({ type: "way", id: Number(xmlAttr(attrs, "id")), version: Number(xmlAttr(attrs, "version")), nodes: nodeIds, tags, geometry });
  }
  return { elements: ways };
}

function fetchOverpassWithFallback(hosts, query, callback) {
  let index = 0;
  const attempt = (lastError) => {
    if (index >= hosts.length) return callback(lastError || new Error("all_overpass_hosts_failed"));
    fetchOverpass(hosts[index++], query, (error, payload) => error ? attempt(error) : callback(null, payload));
  };
  attempt();
}

function normalizeWays(payload) {
  const elements = Array.isArray(payload && payload.elements) ? payload.elements : [];
  const relationsByWay = new Map();
  elements.filter((element) => element && element.type === "relation").forEach((relation) => {
    const normalized = {
      id: Number(relation.id),
      version: Number(relation.version),
      tags: relation.tags && typeof relation.tags === "object" ? relation.tags : {},
      members: Array.isArray(relation.members) ? relation.members.map((member) => ({
        type: String(member.type || ""), ref: Number(member.ref), role: String(member.role || ""),
      })) : [],
    };
    normalized.members.filter((member) => member.type === "way" && Number.isSafeInteger(member.ref)).forEach((member) => {
      if (!relationsByWay.has(member.ref)) relationsByWay.set(member.ref, []);
      relationsByWay.get(member.ref).push(normalized);
    });
  });
  return elements.flatMap((element) => {
    if (!element || element.type !== "way" || !Array.isArray(element.geometry)) return [];
    const coordinates = element.geometry
      .map((point) => [Number(point.lon), Number(point.lat)])
      .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
    if (coordinates.length < 2) return [];
    const tags = element.tags && typeof element.tags === "object" ? element.tags : {};
    const highway = typeof tags.highway === "string" ? tags.highway : "";
    return [{
      id: Number(element.id),
      version: Number.isFinite(Number(element.version)) ? Number(element.version) : null,
      nodes: Array.isArray(element.nodes) ? element.nodes.map(Number).filter(Number.isFinite) : [],
      coordinates,
      tags,
      relations: relationsByWay.get(Number(element.id)) || [],
      priority: ["footway", "pedestrian", "path", "steps", "corridor"].includes(highway)
        ? "pedestrian"
        : "road",
    }];
  });
}

function fetchWalkableNetwork(centerLat, centerLng, radiusMeters = DEFAULT_RADIUS_METERS, host = process.env.OVERPASS_HOST || "overpass-api.de") {
  const radius = Math.round(Math.min(MAX_RADIUS_METERS, Math.max(100, Number(radiusMeters) || DEFAULT_RADIUS_METERS)));
  const cacheKey = `${Number(centerLat).toFixed(3)}:${Number(centerLng).toFixed(3)}:${radius}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return Promise.resolve({ ...cached.response, cached: true });
  return new Promise((resolve, reject) => {
    fetchOverpass(host, buildQuery(centerLat, centerLng, radius), (error, payload) => {
      if (error) return reject(error);
      const ways = normalizeWays(payload);
      const response = { success: true, centerLat, centerLng, radiusMeters: radius, wayCount: ways.length, ways, cached: false };
      cache.set(cacheKey, { createdAt: Date.now(), response });
      resolve(response);
    });
  });
}

function createOsmWalkableNetworkHandler({ sendJson }) {
  const overpassHosts = [...new Set([process.env.OVERPASS_HOST, "overpass.kumi.systems", "overpass.private.coffee", "overpass-api.de"].filter(Boolean))];
  return function handleOsmWalkableNetwork(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const centerLat = Number(url.searchParams.get("centerLat"));
    const centerLng = Number(url.searchParams.get("centerLng"));
    const requestedRadius = Number(url.searchParams.get("radiusMeters"));
    if (!Number.isFinite(centerLat) || centerLat < -90 || centerLat > 90 ||
        !Number.isFinite(centerLng) || centerLng < -180 || centerLng > 180) {
      sendJson(res, 400, { error: "invalid_center" });
      return;
    }
    const radiusMeters = Math.round(
      Math.min(MAX_RADIUS_METERS, Math.max(100, Number.isFinite(requestedRadius) ? requestedRadius : DEFAULT_RADIUS_METERS))
    );
    const cacheKey = `${centerLat.toFixed(3)}:${centerLng.toFixed(3)}:${radiusMeters}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      sendJson(res, 200, { ...cached.response, cached: true });
      return;
    }
    // フィッティング用1km道路網は、現在のOSMデータを直接返す公式map APIを優先する。
    // これによりOverpass混雑時も記録終了までにWayを準備できる。
    fetchOsmMap(centerLat, centerLng, radiusMeters, (mapError, mapPayload) => {
      if (!mapError) {
        const ways = normalizeWays(mapPayload);
        const response = { success: true, centerLat, centerLng, radiusMeters, wayCount: ways.length, ways, cached: false, source: "osm_map_read" };
        cache.set(cacheKey, { createdAt: Date.now(), response });
        sendJson(res, 200, response);
        return;
      }
      console.warn("[osm_walkable] OSM map read failed, trying Overpass:", mapError.message);
      fetchOverpassWithFallback(overpassHosts, buildQuery(centerLat, centerLng, radiusMeters), (overpassError, payload) => {
        if (overpassError) {
          console.error("[osm_walkable] all read sources failed:", overpassError.message);
          sendJson(res, 502, { error: "osm_upstream_error", message: overpassError.message });
          return;
        }
        const ways = normalizeWays(payload);
        const response = { success: true, centerLat, centerLng, radiusMeters, wayCount: ways.length, ways, cached: false, source: "overpass_fallback" };
        cache.set(cacheKey, { createdAt: Date.now(), response });
        sendJson(res, 200, response);
      });
    });
  };
}

module.exports = createOsmWalkableNetworkHandler;
module.exports.buildQuery = buildQuery;
module.exports.normalizeWays = normalizeWays;
module.exports.fetchWalkableNetwork = fetchWalkableNetwork;
module.exports.normalizeOsmXml = normalizeOsmXml;
module.exports.clearWalkableNetworkCache = clearWalkableNetworkCache;
