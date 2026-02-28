const fs = require("fs");
const path = require("path");

// package.jsonからバージョンを読み込む
const packageJson = require("../package.json");
const VERSION = packageJson.version;

console.log(`Updating version to ${VERSION}...`);

// 1. public/version.js を更新
const versionJsPath = path.join(__dirname, "..", "public", "version.js");
const versionJsContent = `// アプリケーションバージョン
const APP_VERSION = "${VERSION}";

// バージョン番号を表示する関数
function displayVersion() {
  const versionElement = document.getElementById("app-version");
  if (versionElement) {
    versionElement.textContent = \`v\${APP_VERSION}\`;
  }
}

// DOMContentLoadedイベントで実行
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", displayVersion);
} else {
  displayVersion();
}
`;

fs.writeFileSync(versionJsPath, versionJsContent, "utf8");
console.log(`✓ Updated ${versionJsPath}`);

// 2. public/sw.js を更新
const swJsPath = path.join(__dirname, "..", "public", "sw.js");
const swJsContent = `const CACHE_VERSION = "${VERSION}"; // このバージョンはpackage.jsonから自動生成されます
const CACHE_NAME = \`barrierfree-map-v\${CACHE_VERSION}-\${Date.now()}\`;
const CORE_ASSETS = [
  "/",
  "/home/Index.html",
  "/style.css",
  "/home/app.js",
  "/version.js",
  "/analog/Index.html",
  "/analog/analog.css",
  "/analog/analog.js",
  "/map/Index.html",
  "/map/map.css",
  "/map/map.js",
  "/manifest.webmanifest",
  "/assets/icon.svg",
  "/auth/login.html",
  "/auth/signup.html",
  "/auth/auth.css",
  "/auth/auth.js",
  "/profile/Index.html",
  "/profile/profile.css",
  "/profile/profile.js",
  "/profile/edit.html",
  "/profile/edit.css",
  "/profile/edit.js",
  "/pwa.js",
];

self.addEventListener("install", (event) => {
  console.log("[SW] Installing new service worker...");
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  // 新しいService Workerをすぐにアクティブにする
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("[SW] Activating new service worker...");
  event.waitUntil(
    caches.keys().then((keys) => {
      // 古いキャッシュをすべて削除
      const deletePromises = keys
        .filter((key) => key.startsWith("barrierfree-map-v") && key !== CACHE_NAME)
        .map((key) => {
          console.log("[SW] Deleting old cache:", key);
          return caches.delete(key);
        });
      return Promise.all(deletePromises);
    }).then(() => {
      // 既存のクライアントをすべて制御下に置く
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});

// メッセージを受け取ってskipWaitingを実行
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    console.log("[SW] Received SKIP_WAITING message");
    self.skipWaiting();
  }
});
`;

fs.writeFileSync(swJsPath, swJsContent, "utf8");
console.log(`✓ Updated ${swJsPath}`);

console.log(`\n✓ All version files updated to ${VERSION}`);
