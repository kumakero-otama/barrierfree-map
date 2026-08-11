const https = require("https");

const DEFAULT_RADIUS_METERS = 1000;
const MAX_RADIUS_METERS = 1500;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

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
  const overpassHost = process.env.OVERPASS_HOST || "overpass-api.de";
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
    fetchOverpass(overpassHost, buildQuery(centerLat, centerLng, radiusMeters), (err, payload) => {
      if (err) {
        console.error("[osm_walkable] fetch error:", err.message);
        sendJson(res, 502, { error: "osm_upstream_error", message: err.message });
        return;
      }
      const ways = normalizeWays(payload);
      const response = { success: true, centerLat, centerLng, radiusMeters, wayCount: ways.length, ways, cached: false };
      cache.set(cacheKey, { createdAt: Date.now(), response });
      sendJson(res, 200, response);
    });
  };
}

module.exports = createOsmWalkableNetworkHandler;
module.exports.buildQuery = buildQuery;
module.exports.normalizeWays = normalizeWays;
module.exports.fetchWalkableNetwork = fetchWalkableNetwork;
