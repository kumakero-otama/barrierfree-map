const https = require("https");

const ALLOWED_VALUES = new Set([
  "yes",
  "left",
  "right",
  "both",
  "perpendicular",
  "direction_of_travel",
]);

function buildOverpassQuery(centerLat, centerLng, radiusMeters) {
  return `
[out:json][timeout:25];
way(around:${radiusMeters},${centerLat},${centerLng})["tactile_paving"~"^(yes|left|right|both|perpendicular|direction_of_travel)$"];
out geom;
`;
}

function fetchOverpass(overpassHost, query, callback) {
  const body = `data=${encodeURIComponent(query)}`;
  const options = {
    hostname: overpassHost,
    path: "/api/interpreter",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
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

  req.on("error", (err) => {
    callback(new Error(`overpass_request_error:${err.message}`));
  });
  req.write(body);
  req.end();
}

function toFeatureCollection(overpassJson) {
  const elements = Array.isArray(overpassJson && overpassJson.elements) ? overpassJson.elements : [];
  const features = [];

  elements.forEach((el) => {
    if (!el || el.type !== "way" || !Array.isArray(el.geometry) || el.geometry.length < 2) {
      return;
    }
    const tactileValue = el.tags && typeof el.tags.tactile_paving === "string"
      ? el.tags.tactile_paving
      : "";
    if (!ALLOWED_VALUES.has(tactileValue)) {
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
        tactile_paving: tactileValue,
      },
      geometry: {
        type: "LineString",
        coordinates,
      },
    });
  });

  return {
    type: "FeatureCollection",
    features,
  };
}

function createOsmTactileWaysHandler({ sendJson }) {
  const OVERPASS_HOST = process.env.OVERPASS_HOST || "overpass-api.de";

  return function handleOsmTactileWays(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const centerLat = Number(url.searchParams.get("centerLat"));
      const centerLng = Number(url.searchParams.get("centerLng"));
      const radiusKmRaw = Number(url.searchParams.get("radiusKm"));
      const radiusKm = Number.isFinite(radiusKmRaw) && radiusKmRaw > 0 ? radiusKmRaw : 10;
      const radiusMeters = Math.round(Math.min(radiusKm, 10) * 1000);

      if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng)) {
        sendJson(res, 400, { error: "invalid_center" });
        return;
      }

      const query = buildOverpassQuery(centerLat, centerLng, radiusMeters);
      fetchOverpass(OVERPASS_HOST, query, (err, overpassJson) => {
        if (err) {
          console.error("[osm_tactile] fetch error:", err.message);
          sendJson(res, 502, { error: "osm_upstream_error", message: err.message });
          return;
        }
        const featureCollection = toFeatureCollection(overpassJson);
        sendJson(res, 200, {
          success: true,
          centerLat,
          centerLng,
          radiusKm: radiusMeters / 1000,
          count: featureCollection.features.length,
          features: featureCollection.features,
        });
      });
    } catch (err) {
      console.error("[osm_tactile] handler error:", err.message);
      sendJson(res, 500, { error: "osm_tactile_handler_error", message: err.message });
    }
  };
}

module.exports = createOsmTactileWaysHandler;
