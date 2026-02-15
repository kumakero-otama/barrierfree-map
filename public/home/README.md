# home ページ構成

このフォルダはアプリのホーム画面です。  
ルートアクセス `/` は `server.js` で `/home/Index.html` に誘導されます。

## ファイル一覧

### `Index.html`
- ホーム画面本体。
- 役割:
  - アプリ起動確認用の「It works!」表示
  - 現在時刻表示領域（`#clock`）
  - 画面遷移リンク:
    - `/analog/Index.html`
    - `/map/Index.html`
  - バージョン表示（`#app-version`）
- 読み込むスクリプト:
  - `app.js`（このフォルダ内）
  - `/version.js`（共通バージョン表示更新）
  - `/pwa.js`（PWA更新検知）

### `app.js`
- ホーム画面のデジタル時計更新ロジック。
- 主要処理:
  - `updateClock()` で `HH:MM:SS` を組み立て
  - `#clock` に反映
  - 1秒ごとに更新（`setInterval`）

