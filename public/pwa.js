
if ("serviceWorker" in navigator) {
  // 同一ページ内で多重リロードしないためのフラグ。
  let refreshing = false;

  // Service Workerの更新を監視
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    console.log("[PWA] New service worker activated, reloading...");
    window.location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        console.log("[PWA] Service Worker registered");

        // 定期的に更新をチェック（1時間ごと）
        setInterval(() => {
          console.log("[PWA] Checking for updates...");
          registration.update().catch(() => {
            // ignore update errors
          });
        }, 60 * 60 * 1000);

        // ページ表示時に即座に更新をチェック
        registration.update().catch(() => {
          // ignore update errors
        });

        // 新しいService Workerが待機中の場合（ページロード時）
        if (registration.waiting) {
          console.log("[PWA] New service worker waiting, activating automatically...");
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }

        // 新しいService Workerが見つかった時
        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          console.log("[PWA] New service worker found");

          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              console.log("[PWA] New service worker installed, activating automatically...");
              // 自動的に新しいService Workerに切り替え
              newWorker.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
      })
      .catch(() => {
        // ignore registration errors
      });
  });

  // タブ復帰時にも更新確認して古いキャッシュ滞留を減らす。
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      navigator.serviceWorker.ready.then((registration) => {
        registration.update().catch(() => {
          // ignore update errors
        });
      });
    }
  });
}
