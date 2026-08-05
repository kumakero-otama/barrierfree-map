const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const createMatchHandler = require("./server/api/match_valhalla");
const createCountHandler = require("./server/api/count");
const createStatsHandler = require("./server/api/stats");
const createSessionHandler = require("./server/api/session");
const createConfigHandler = require("./server/api/config");
const createRecordsHandler = require("./server/api/records");
const createTraceHandler = require("./server/api/trace");
const createOsmTactileWaysHandler = require("./server/api/osm_tactile");
const createOsmWalkableNetworkHandler = require("./server/api/osm_walkable");
const createFittingComparisonsHandler = require("./server/api/fitting_comparisons");
const createOsmChangesHandler = require("./server/api/osm_changes");
const createFittingDetailsHandler = require("./server/api/fitting_details");
const createPostTagsHandler = require("./server/api/post_tags");
const createRoadInfoHandler = require("./server/api/road_info");
const createGoogleAuthHandler = require("./server/api/google_auth");
const createOsmOAuthHandler = require("./server/api/osm_oauth");
const createProStatusHandler = require("./server/api/pro_status");
const createTactileTagsHandler = require("./server/api/tactile_tags");
const createClientLogsHandler = require("./server/api/client_logs");
const createTactileRankingHandler = require("./server/api/tactile_ranking");
const createHealthHandler = require("./server/api/health");
const createDevApiGuard = require("./server/security/dev_api_guard");
const { createLogger } = require("./server/logger");

// HTTP/HTTPS の待受先。開発環境を本番と別ポート・localhost限定で起動できるようにする。
const HTTP_HOST = process.env.HTTP_HOST || "0.0.0.0";
const HTTP_PORT = parseInt(process.env.HTTP_PORT, 10) || 3000;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 3001;
// 外部サービスや TLS 関連は環境変数から受け取り、未設定でも起動自体は継続する。
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || "";
const TLS_KEY_PATH = process.env.TLS_KEY_PATH || "";
const TLS_CERT_PATH = process.env.TLS_CERT_PATH || "";
const MIN_INTERVAL_MS = parseInt(process.env.MIN_INTERVAL_MS, 10) || 1000;
const CLIENT_MIN_INTERVAL_MS = parseInt(process.env.CLIENT_MIN_INTERVAL_MS, 10) || 2000;
const MAX_MATCH_CALLS_PER_MONTH = 100000;
const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  "808129330394-dagp56961vbank89vi7bc50pp4u7mgv8.apps.googleusercontent.com";
const COUNT_FILE = path.join(__dirname, "data", "mapbox-count.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const LOG_DIR = path.join(__dirname, "logs");
const SERVER_LOG = path.join(LOG_DIR, "server.csv");
let monthlyCounts = {};
// カンマ区切りの許可 Origin 一覧を正規化して保持する。
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

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

// 端末出力を維持したまま、同じ内容を CSV ログへも保存するために console を差し替える。
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
// 端末単位の直近アクセス時刻を保持し、マッチング API の簡易レート制限に使う。
const lastRequestByDevice = new Map();

// 最低限の静的配信で使う Content-Type 一覧。
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

// 静的ファイル配信と旧 URL からのリダイレクトをまとめて処理する。
function handleStatic(req, res) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  // 旧パスでアクセスされた場合は新しいページ構成へリダイレクトする。
  const legacyPathMap = {
    "/index.html": "/auth/login.html",
    "/home/index.html": "/auth/login.html",
    "/map/index.html": "/map/Index.html",
    "/profile/index.html": "/profile/Index.html",
    "/analog/index.html": "/auth/login.html",
    "/post_road.html": "/post_road/Index.html",
    "/post_road/index.html": "/post_road/Index.html",
    "/otasuke.html": "/otasuke/Index.html",
    "/otasuke/index.html": "/otasuke/Index.html",
    "/road_info_detail.html": "/road_info_detail/Index.html",
    "/road_info_detail/index.html": "/road_info_detail/Index.html",
    "/auth/signup_profile": "/auth/signup_profile.html",
    "/docs": "/docs/index.html",
    "/docs/": "/docs/index.html",
  };
  const lowerPath = requestUrl.pathname.toLowerCase();
  const canonicalPath = requestUrl.pathname === "/"
    ? "/auth/login.html"
    : (legacyPathMap[lowerPath] || requestUrl.pathname);
  if (requestUrl.pathname !== canonicalPath) {
    // 旧 URL へ来たクライアントを正規パスへ寄せ、古いブックマーク互換を保つ。
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

// uploads 配下の配信専用ハンドラ。パス正規化でディレクトリトラバーサルを防ぐ。
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
    // /uploads/ 配下のファイルはアップロード時にユニークなファイル名（タイムスタンプ等）が付くため、
    // 同URLの内容は変わらない前提で長期キャッシュを許可する。
    // ブラウザのHTTPキャッシュ・サービスワーカーキャッシュ双方が効きやすくなる。
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.end(data);
  });
}

// JSON レスポンスのヘッダーと文字コードを統一する共通関数。
function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// CORS を許可する Origin を限定し、本番配信先とローカル開発環境だけ通す。
function isCorsOriginAllowed(origin) {
  if (!origin || typeof origin !== "string") {
    return false;
  }
  if (CORS_ALLOWED_ORIGINS.includes(origin)) {
    return true;
  }
  if (/^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin)) {
    return true;
  }
  if (/^https?:\/\/localhost(?::\d+)?$/i.test(origin)) {
    return true;
  }
  if (/^https?:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin)) {
    return true;
  }
  return false;
}

// CORS 対象リクエストへ必要なヘッダーを付け、preflight にも使えるようにする。
function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!isCorsOriginAllowed(origin)) {
    return false;
  }

  const requestedHeaders = req.headers["access-control-request-headers"];
  const allowHeaders = requestedHeaders && String(requestedHeaders).trim()
    ? String(requestedHeaders)
    : "Content-Type, Authorization";

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", allowHeaders);
  res.setHeader("Access-Control-Max-Age", "86400");
  if (String(req.headers["access-control-request-private-network"] || "").toLowerCase() === "true") {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  return true;
}

// セッション削除・キャンセル状態を API 間で共有し、後続の非同期保存を止める。
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

const handleStats = createStatsHandler({
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

const handleOsmWalkableNetwork = createOsmWalkableNetworkHandler({
  sendJson,
});

const handleFittingComparisons = createFittingComparisonsHandler({
  sendJson,
});

const handleOsmChanges = createOsmChangesHandler({
  sendJson,
});
const handleFittingDetails = createFittingDetailsHandler({ sendJson });

const handlePostTags = createPostTagsHandler({
  sendJson,
});

const handleRoadInfo = createRoadInfoHandler({
  sendJson,
});

const handleGoogleAuth = createGoogleAuthHandler({
  sendJson,
  GOOGLE_CLIENT_ID,
});
const handleOsmOAuth = createOsmOAuthHandler({ sendJson });

const handleProStatus = createProStatusHandler({
  sendJson,
});

const handleTactileTags = createTactileTagsHandler({
  sendJson,
});

const handleClientLogs = createClientLogsHandler({
  sendJson,
  LOG_DIR,
});

const handleTactileRanking = createTactileRankingHandler({
  sendJson,
});
const handleHealth = createHealthHandler({ sendJson });

const guardDevApi = createDevApiGuard({
  sendJson,
  logDir: LOG_DIR,
  allowedOrigins: CORS_ALLOWED_ORIGINS,
});

// API を先に振り分け、該当しないものだけ静的ファイル配信へフォールバックする。
function handleRequest(req, res) {
  const isCorsRequest = applyCorsHeaders(req, res);
  if (req.method === "OPTIONS" && isCorsRequest) {
    // preflight 応答は本文不要なので 204 で即終了する。
    res.writeHead(204);
    res.end();
    return;
  }
  if (!guardDevApi(req, res)) {
    return;
  }

  // APIパスを先に判定し、それ以外は静的配信へフォールバックする。
  if (req.url && req.url.startsWith("/api/match")) {
    handleMatch(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/count")) {
    handleCount(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/stats")) {
    handleStats(req, res);
    return;
  }
  if (
    req.url &&
    (
      req.url.startsWith("/api/client-logs") ||
      req.url.startsWith("/api/tactile-session-info") ||
      req.url.startsWith("/api/tactile-tags") ||
      req.url.startsWith("/api/session-tags")
    )
  ) {
    if (req.url.startsWith("/api/client-logs")) {
      handleClientLogs(req, res);
      return;
    }
    handleTactileTags(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/auth/osm/")) {
    handleOsmOAuth(req, res);
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
  if (req.url && req.url.startsWith("/api/health")) {
    handleHealth(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/records")) {
    handleRecords(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/tactile-ranking")) {
    handleTactileRanking(req, res);
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
  if (req.url && req.url.startsWith("/api/osm-walkable-network")) {
    handleOsmWalkableNetwork(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/fitting-comparisons")) {
    handleFittingComparisons(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/fitting-details")) {
    handleFittingDetails(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/api/osm/")) {
    handleOsmChanges(req, res);
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
  if (req.url && req.url.startsWith("/api/pro-status")) {
    handleProStatus(req, res);
    return;
  }
  if (
    req.url &&
    (
      req.url.startsWith("/auth/guest") ||
      req.url.startsWith("/auth/google") ||
      req.url.startsWith("/auth/me") ||
      req.url.startsWith("/auth/logout") ||
      req.url.startsWith("/auth/profile")
    )
  ) {
    handleGoogleAuth(req, res);
    return;
  }
  if (req.url && req.url.startsWith("/uploads/")) {
    handleUploads(req, res);
    return;
  }
  handleStatic(req, res);
}

http.createServer(handleRequest).listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`http://${HTTP_HOST}:${HTTP_PORT}`);
});

if (TLS_KEY_PATH && TLS_CERT_PATH) {
  try {
    // 鍵と証明書が両方ある場合のみ HTTPS サーバーを追加で立ち上げる。
    const key = fs.readFileSync(TLS_KEY_PATH);
    const cert = fs.readFileSync(TLS_CERT_PATH);
    https.createServer({ key, cert }, handleRequest).listen(HTTPS_PORT, HTTP_HOST, () => {
      console.log(`https://${HTTP_HOST}:${HTTPS_PORT}`);
    });
  } catch (err) {
    console.warn("https_start_failed", err.message);
  }
} else {
  console.warn("https_disabled_missing_tls");
}
