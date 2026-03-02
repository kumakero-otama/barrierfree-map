const CACHE_VERSION = "1.18.0"; // このバージョンはpackage.jsonから自動生成されます
const CACHE_NAME = `barrierfree-map-v${CACHE_VERSION}-${Date.now()}`;
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
