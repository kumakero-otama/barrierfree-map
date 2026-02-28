
if ("serviceWorker" in navigator) {
  // 同一ページ内で多重リロードしないためのフラグ。
  // controllerchange は環境によって複数回発火し得るため、1回だけ reload する。
  let refreshing = false;

  // Service Workerの更新を監視
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    console.log("[PWA] New service worker activated, reloading...");
    // 新SW制御下の最新HTML/CSS/JSを反映するため、制御切替時に1回リロードする。
    window.location.reload();
  });

  window.addEventListener("load", () => {
    // ページロード完了後にSWを登録。
    // 初回アクセスではインストール、既存環境ではアップデート確認の起点になる。
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        console.log("[PWA] Service Worker registered");

        // 定期的に更新をチェック（1時間ごと）
        // 長時間開きっぱなしのタブでも新バージョンを検知できるようにする。
        setInterval(() => {
          console.log("[PWA] Checking for updates...");
          registration.update().catch(() => {
            // ignore update errors
          });
        }, 60 * 60 * 1000);

        // ページ表示時に即座に更新をチェック
        // 次の1時間待ちを避け、訪問直後に新SWがあれば拾う。
        registration.update().catch(() => {
          // ignore update errors
        });

        // 新しいService Workerが待機中の場合（ページロード時）
        // すでに waiting なら即アクティブ化要求を送り、更新反映を前倒しする。
        if (registration.waiting) {
          console.log("[PWA] New service worker waiting, activating automatically...");
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }

        // 新しいService Workerが見つかった時
        // updatefound -> installing のライフサイクルを監視する。
        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          console.log("[PWA] New service worker found");

          newWorker.addEventListener("statechange", () => {
            // installed かつ controller が存在:
            // 「初回インストール」ではなく「既存SWからの更新完了」を意味する。
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              console.log("[PWA] New service worker installed, activating automatically...");
              // 自動的に新しいService Workerに切り替え
              // SW側の message ハンドラで skipWaiting が実行される。
              newWorker.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
      })
      .catch(() => {
        // SW非対応ブラウザや一時的エラー時は通常Webとして継続利用。
        // ignore registration errors
      });
  });

  // タブ復帰時にも更新確認して古いキャッシュ滞留を減らす。
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      // ready は active な registration を返すため、復帰時更新チェックに使う。
      navigator.serviceWorker.ready.then((registration) => {
        registration.update().catch(() => {
          // ignore update errors
        });
      });
    }
  });
}
