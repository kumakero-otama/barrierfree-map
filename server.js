const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const HTTPS_PORT = 3000;
const HTTP_PORT = 3001;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || "";
const MIN_INTERVAL_MS = 5000;
const MAX_MATCH_CALLS_PER_MONTH = 100000;
const COUNT_FILE = path.join(__dirname, "mapbox-count.json");
let monthlyCounts = {};

function getCurrentMonth() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function loadCount() {
  try {
    const raw = fs.readFileSync(COUNT_FILE, "utf8");
    const data = JSON.parse(raw);
    if (typeof data === "object" && data !== null) {
      monthlyCounts = data;
    }
  } catch {
    // ignore missing/invalid file
    monthlyCounts = {};
  }
}

function saveCount() {
  try {
    fs.writeFileSync(COUNT_FILE, JSON.stringify(monthlyCounts, null, 2), "utf8");
  } catch {
    // ignore write errors
  }
}

function getMonthlyCount(month) {
  return monthlyCounts[month] || 0;
}

function incrementMonthlyCount(month) {
  monthlyCounts[month] = getMonthlyCount(month) + 1;
  saveCount();
}

loadCount();
const lastRequestByIp = new Map();

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function handleStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(__dirname, requestPath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function handleMatch(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!MAPBOX_TOKEN) {
    sendJson(res, 500, { error: "missing_mapbox_token" });
    return;
  }
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lng = parseFloat(url.searchParams.get("lng"));

  const currentMonth = getCurrentMonth();
  const currentCount = getMonthlyCount(currentMonth);

  if (currentCount >= MAX_MATCH_CALLS_PER_MONTH) {
    sendJson(res, 200, { lat, lng, skipped: "quota_reached", count: currentCount, month: currentMonth });
    return;
  }
  const prevLat = parseFloat(url.searchParams.get("prevLat"));
  const prevLng = parseFloat(url.searchParams.get("prevLng"));

  const ip = req.socket.remoteAddress || "unknown";
  console.log(`raw_lat=${lat}, raw_lng=${lng}, ip=${ip}`);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    sendJson(res, 400, { error: "invalid_coordinates" });
    return;
  }

  const now = Date.now();
  const last = lastRequestByIp.get(ip) || 0;
  if (now - last < MIN_INTERVAL_MS) {
    sendJson(res, 429, { error: "rate_limited", retryAfterMs: MIN_INTERVAL_MS - (now - last) });
    return;
  }
  lastRequestByIp.set(ip, now);

  let coords;
  if (!Number.isFinite(prevLat) || !Number.isFinite(prevLng)) {
    // 初回リクエスト時は、同じ座標を2回送信して道路にスナップ
    coords = `${lng},${lat};${lng},${lat}`;
    console.log(`match request (first time): lat=${lat}, lng=${lng}`);
  } else {
    coords = `${prevLng},${prevLat};${lng},${lat}`;
    console.log(`match request: lat=${lat}, lng=${lng}, prevLat=${prevLat}, prevLng=${prevLng}`);
  }

  console.log(`send_lat=${lat}, send_lng=${lng}`);
  const matchUrl = new URL(
    `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}`
  );
  matchUrl.searchParams.set("access_token", MAPBOX_TOKEN);
  matchUrl.searchParams.set("geometries", "geojson");
  matchUrl.searchParams.set("overview", "full");
  matchUrl.searchParams.set("steps", "false");
  matchUrl.searchParams.set("radiuses", "25;25");
  matchUrl.searchParams.set("tidy", "false");
  console.log(`mapbox_request_url=${matchUrl.toString()}`);

  incrementMonthlyCount(currentMonth);
  const newCount = getMonthlyCount(currentMonth);
  https
    .get(matchUrl, (apiRes) => {
      let body = "";
      apiRes.on("data", (chunk) => {
        body += chunk;
      });
      apiRes.on("end", () => {
        console.log(`mapbox_response_status=${apiRes.statusCode || 0}`);
        console.log(`mapbox_response_body=${body}`);
        try {
          const data = JSON.parse(body);
          const tracepoints = Array.isArray(data.tracepoints) ? data.tracepoints : [];
          const lastPoint = tracepoints[tracepoints.length - 1];
          if (lastPoint && Array.isArray(lastPoint.location)) {
            const [snappedLng, snappedLat] = lastPoint.location;
            sendJson(res, 200, { lat: snappedLat, lng: snappedLng, count: newCount, month: currentMonth });
            return;
          }
        } catch {
          // fall through to fallback
        }
        sendJson(res, 200, { lat, lng, count: newCount, month: currentMonth });
      });
    })
    .on("error", (err) => {
      console.log(`mapbox_response_error=${err.message}`);
      sendJson(res, 200, { lat, lng, count: newCount, month: currentMonth });
    });
}

function handleCount(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  const currentMonth = getCurrentMonth();
  const currentCount = getMonthlyCount(currentMonth);
  sendJson(res, 200, { 
    count: currentCount, 
    max: MAX_MATCH_CALLS_PER_MONTH,
    month: currentMonth,
    allMonths: monthlyCounts
  });
}

const tlsOptions = {
  key: fs.readFileSync(path.join(__dirname, "localhost-key.pem")),
  cert: fs.readFileSync(path.join(__dirname, "localhost-cert.pem")),
};

https.createServer(tlsOptions, (req, res) => {
  if (req.url && req.url.startsWith("/api/match")) {
    handleMatch(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/count")) {
    handleCount(req, res);
    return;
  }
  handleStatic(req, res);
}).listen(HTTPS_PORT, () => {
  console.log(`https://localhost:${HTTPS_PORT}`);
});

http.createServer((req, res) => {
  const host = (req.headers.host || "localhost").split(":")[0];
  res.writeHead(301, { Location: `https://${host}:${HTTPS_PORT}${req.url}` });
  res.end();
}).listen(HTTP_PORT, () => {
  console.log(`http://localhost:${HTTP_PORT} -> https://localhost:${HTTPS_PORT}`);
});
