const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const createMatchHandler = require("./server/api/match");
const createCountHandler = require("./server/api/count");

const HTTP_PORT = 3000;
const HTTPS_PORT = 3001;
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || "";
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || "";
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || "";
const MIN_INTERVAL_MS = 4000;
const MAX_MATCH_CALLS_PER_MONTH = 100000;
const COUNT_FILE = path.join(__dirname, "data", "mapbox-count.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const LOG_DIR = path.join(__dirname, "logs");
const SERVER_LOG = path.join(LOG_DIR, "server.csv");
let monthlyCounts = {};

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

function toCsv(fields) {
  return fields
    .map((field) => {
      const value = String(field ?? "");
      const escaped = value.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(",");
}

function appendLog(level, message) {
  const timestamp = new Date().toISOString();
  const line = `${toCsv([timestamp, level, message])}\n`;
  // 非同期書き込みでI/Oブロッキングを回避
  fs.appendFile(SERVER_LOG, line, "utf8", (err) => {
    // ignore write errors
  });
}

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

ensureLogDir();
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
  ".webmanifest": "application/manifest+json",
};

function handleStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url;
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const handleMatch = createMatchHandler({
  https,
  MAPBOX_TOKEN,
  MIN_INTERVAL_MS,
  MAX_MATCH_CALLS_PER_MONTH,
  lastRequestByIp,
  getCurrentMonth,
  getMonthlyCount,
  incrementMonthlyCount,
  sendJson,
});

const handleCount = createCountHandler({
  MAX_MATCH_CALLS_PER_MONTH,
  getCurrentMonth,
  getMonthlyCount,
  monthlyCounts,
  sendJson,
});

function handleRequest(req, res) {
  if (req.url && req.url.startsWith("/api/match")) {
    handleMatch(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/count")) {
    handleCount(req, res);
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
