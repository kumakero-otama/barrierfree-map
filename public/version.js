// アプリケーションバージョン
const APP_VERSION = "1.18.6";

// バージョン番号を表示する関数
function displayVersion() {
  const versionElement = document.getElementById("app-version");
  if (versionElement) {
    versionElement.textContent = `v${APP_VERSION}`;
  }
}

// DOMContentLoadedイベントで実行
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", displayVersion);
} else {
  displayVersion();
}
