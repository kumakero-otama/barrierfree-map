const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const createMatchHandler = require("./server/api/match_valhalla");
const createCountHandler = require("./server/api/count");
const createSessionHandler = require("./server/api/session");
const createConfigHandler = require("./server/api/config");
const createRecordsHandler = require("./server/api/records");
const createTraceHandler = require("./server/api/trace");
const createOsmTactileWaysHandler = require("./server/api/osm_tactile");
const createPostTagsHandler = require("./server/api/post_tags");
const createRoadInfoHandler = require("./server/api/road_info");
const { createLogger } = require("./server/logger");

const HTTP_PORT = 3000;
const HTTPS_PORT = 3001;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || "";
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || "";
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || "";
const MIN_INTERVAL_MS = parseInt(process.env.MIN_INTERVAL_MS, 10) || 1000;
const CLIENT_MIN_INTERVAL_MS = parseInt(process.env.CLIENT_MIN_INTERVAL_MS, 10) || 2000;
const MAX_MATCH_CALLS_PER_MONTH = 100000;
const COUNT_FILE = path.join(__dirname, "data", "mapbox-count.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const LOG_DIR = path.join(__dirname, "logs");
const SERVER_LOG = path.join(LOG_DIR, "server.csv");
let monthlyCounts = {};

const logger = createLogger(SERVER_LOG);
const { appendLog } = logger;

// console引数をログ保存しやすい文字列へ整形する。
function formatMessage(args) {
  return args
    .map((arg) => {
      if (typeof arg === "string") {
        return arg;
      }
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

appendLog("INFO", "server_start");

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args) => {
  appendLog("INFO", formatMessage(args));
  originalLog(...args);
};

console.warn = (...args) => {
  appendLog("WARN", formatMessage(args));
  originalWarn(...args);
};

console.error = (...args) => {
  appendLog("ERROR", formatMessage(args));
  originalError(...args);
};

function getCurrentMonth() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

// 月次カウンタJSONを起動時に読み込む。
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

// 月次カウンタJSONを書き戻す。
function saveCount() {
  try {
    fs.writeFileSync(COUNT_FILE, JSON.stringify(monthlyCounts, null, 2), "utf8");
  } catch {
    // ignore write errors
  }
}

// 指定月のカウント値を返す（未定義は0）。
function getMonthlyCount(month) {
  return monthlyCounts[month] || 0;
}

// 指定月のカウントを1増やし、即時保存する。
function incrementMonthlyCount(month) {
  monthlyCounts[month] = getMonthlyCount(month) + 1;
  saveCount();
}

loadCount();
const lastRequestByDevice = new Map();

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
  ".webmanifest": "application/manifest+json",
};

function handleStatic(req, res) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  // 旧パスでアクセスされた場合は新しいページ構成へリダイレクトする。
  const legacyPathMap = {
    "/index.html": "/home/Index.html",
    "/home/index.html": "/home/Index.html",
    "/map/index.html": "/map/Index.html",
    "/analog/index.html": "/analog/Index.html",
    "/post_road.html": "/post_road/Index.html",
    "/post_road/index.html": "/post_road/Index.html",
    "/otasuke.html": "/otasuke/Index.html",
    "/otasuke/index.html": "/otasuke/Index.html",
    "/road_info_detail.html": "/road_info_detail/Index.html",
    "/road_info_detail/index.html": "/road_info_detail/Index.html",
  };
  const lowerPath = requestUrl.pathname.toLowerCase();
  const canonicalPath = requestUrl.pathname === "/"
    ? "/home/Index.html"
    : (legacyPathMap[lowerPath] || requestUrl.pathname);
  if (requestUrl.pathname !== canonicalPath) {
    res.writeHead(302, { Location: canonicalPath });
    res.end();
    return;
  }
  const requestPath = canonicalPath;
  // public配下の静的ファイルを拡張子に応じたContent-Typeで返す。
  const filePath = path.join(PUBLIC_DIR, requestPath);
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

function handleUploads(req, res) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  // uploads外に出ないようパス正規化してディレクトリトラバーサルを防ぐ。
  const requestPath = requestUrl.pathname.replace(/^\/uploads\//, "");
  const normalized = path
    .normalize(requestPath)
    .replace(/^([/\\])+/, "")
    .replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.resolve(UPLOADS_DIR, normalized);
  const uploadsRoot = path.resolve(UPLOADS_DIR);
  if (!filePath.startsWith(`${uploadsRoot}${path.sep}`) && filePath !== uploadsRoot) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }
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

const deletedSessionKeys = new Set();
const canceledSessionIds = new Set();

const handleMatch = createMatchHandler({
  https,
  MAPBOX_TOKEN,
  MIN_INTERVAL_MS,
  MAX_MATCH_CALLS_PER_MONTH,
  lastRequestByDevice,
  getCurrentMonth,
  getMonthlyCount,
  incrementMonthlyCount,
  deletedSessionKeys,
  canceledSessionIds,
  sendJson,
});

const handleCount = createCountHandler({
  MAX_MATCH_CALLS_PER_MONTH,
  getCurrentMonth,
  getMonthlyCount,
  monthlyCounts,
  sendJson,
});

const handleSession = createSessionHandler({
  deletedSessionKeys,
  canceledSessionIds,
  sendJson,
});

const handleConfig = createConfigHandler({
  MIN_INTERVAL_MS,
  CLIENT_MIN_INTERVAL_MS,
  sendJson,
});

const handleRecords = createRecordsHandler({
  sendJson,
});

const handleTrace = createTraceHandler({
  canceledSessionIds,
  sendJson,
});

const handleOsmTactileWays = createOsmTactileWaysHandler({
  sendJson,
});

const handlePostTags = createPostTagsHandler({
  sendJson,
});

const handleRoadInfo = createRoadInfoHandler({
  sendJson,
});

function handleRequest(req, res) {
  // APIパスを先に判定し、それ以外は静的配信へフォールバックする。
  if (req.url && req.url.startsWith("/api/match")) {
    handleMatch(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/count")) {
    handleCount(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/session")) {
    handleSession(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/config")) {
    handleConfig(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/records")) {
    handleRecords(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/trace")) {
    handleTrace(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/osm-tactile-ways")) {
    handleOsmTactileWays(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/post-tags")) {
    handlePostTags(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/road-info")) {
    handleRoadInfo(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/uploads/")) {
    handleUploads(req, res);
    return;
  }
  handleStatic(req, res);
}

http.createServer(handleRequest).listen(HTTP_PORT, () => {
  console.log(`http://localhost:${HTTP_PORT}`);
});

if (TLS_KEY_PATH && TLS_CERT_PATH) {
  try {
    const key = fs.readFileSync(TLS_KEY_PATH);
    const cert = fs.readFileSync(TLS_CERT_PATH);
    https.createServer({ key, cert }, handleRequest).listen(HTTPS_PORT, () => {
      console.log(`https://localhost:${HTTPS_PORT}`);
    });
  } catch (err) {
    console.warn("https_start_failed", err.message);
  }
} else {
  console.warn("https_disabled_missing_tls");
}
