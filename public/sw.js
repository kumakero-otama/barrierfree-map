// キャッシュの論理バージョン。
// デプロイやアセット更新時に値が変わると、別名キャッシュとして再作成される。
const CACHE_VERSION = "1.14.0"; // このバージョンはpackage.jsonから自動生成されます
// 同一バージョンでも「今回インストールしたSW用」のキャッシュをユニーク化するため時刻を付与。
// activate時に prefix で古い世代を掃除する設計なので、ここを都度変えることで確実に入れ替えられる。
const CACHE_NAME = `barrierfree-map-v${CACHE_VERSION}-${Date.now()}`;
// 先行キャッシュしておく静的アセット一覧。
// install時に addAll され、初回表示やオフライン時の土台になる。
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
  "/pwa.js",
];

self.addEventListener("install", (event) => {
  console.log("[SW] Installing new service worker...");
  event.waitUntil(
    // SWのインストール完了条件:
    // ここで列挙したコア資産がキャッシュに入ること。
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  // 新しいService Workerをすぐにアクティブにする
  // 通常は waiting 状態になるが、skipWaiting で待機を短縮して更新反映を早める。
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("[SW] Activating new service worker...");
  event.waitUntil(
    caches.keys().then((keys) => {
      // 古いキャッシュをすべて削除
      // 現在の CACHE_NAME 以外で、同アプリprefixのものを削除する。
      const deletePromises = keys
        .filter((key) => key.startsWith("barrierfree-map-v") && key !== CACHE_NAME)
        .map((key) => {
          console.log("[SW] Deleting old cache:", key);
          return caches.delete(key);
        });
      return Promise.all(deletePromises);
    }).then(() => {
      // 既存のクライアントをすべて制御下に置く
      // 次回遷移を待たずに、開いているタブへ新SWの制御を適用する。
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // GET 以外（POST/PUT等）はキャッシュ戦略の対象外。
  // API更新やフォーム送信を誤ってキャッシュしないためのガード。
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  // 他オリジンはブラウザ通常処理に任せる（CDNや外部API等）。
  if (url.origin !== self.location.origin) {
    return;
  }
  // /api は動的データ前提なのでSWキャッシュから除外。
  // 常にネットワーク要求にして最新データ取得を優先する。
  if (url.pathname.startsWith("/api/")) {
    return;
  }
  // HTMLナビゲーション要求:
  // Network First（成功時はキャッシュ更新、失敗時はキャッシュへフォールバック）
  // 目的: 通常時は最新HTML、オフライン時は前回取得HTMLで継続利用。
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Response本体は一度しか読めないため clone してキャッシュ保存。
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        // ネットワーク失敗時のみ過去キャッシュを返す。
        .catch(() => caches.match(request))
    );
    return;
  }
  // 静的アセット要求:
  // Cache First（ヒット時即返却、ミス時は取得してキャッシュ）
  // 目的: 表示速度向上とオフライン耐性。
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(request).then((response) => {
        // 取得した静的資産を次回以降に備えて保存。
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});

// メッセージを受け取ってskipWaitingを実行
self.addEventListener("message", (event) => {
  // クライアント側（pwa.js）から更新反映を即時化する指示を受ける。
  if (event.data && event.data.type === "SKIP_WAITING") {
    console.log("[SW] Received SKIP_WAITING message");
    self.skipWaiting();
  }
});
