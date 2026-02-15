# map ページ構成

このフォルダは地図画面です。  
位置取得、軌跡記録、外部データ表示、投稿画面遷移を担当します。

## ファイル一覧

### `Index.html`
- 地図画面のUI定義。
- 役割:
  - Leaflet地図表示領域（`#map`）
  - 各トグルUI:
    - 点字ブロック記録
    - アプリ点字ブロック表示
    - OSM点字ブロック表示
    - 道情報の表示
    - 現在地の中央表示
  - お助け投稿ボタン（`/otasuke/Index.html`）
  - バージョン表示
  - 記録停止時の確認モーダル
- 読み込むスクリプト:
  - `map.js`
  - `/version.js`
  - `/pwa.js`

### `map.css`
- 地図画面専用のスタイル。
- 主な対象:
  - 2カラムレイアウト（地図 + サイドパネル）
  - トグルスイッチUI
  - 記録確認モーダルの見た目
  - モバイル向けレスポンシブ調整

### `map.js`
- 地図画面のメインロジック。
- 主要処理:
  - Leaflet地図の初期化と現在地マーカー更新
  - `navigator.geolocation.watchPosition` による位置追跡
  - `/api/match` でスナップ位置取得
  - 記録セッション開始/終了（`/api/session/*`）
  - 軌跡トレース生成（`/api/trace`）
  - 既存軌跡表示（`/api/records`）
  - OSM点字ブロック表示（`/api/osm-tactile-ways`）
  - 道情報ピン表示（`/api/road-info`）
  - 道情報ピンクリックで詳細画面へ遷移（`/road_info_detail/Index.html?pointId=...`）
  - 地図タップで投稿画面へ遷移（`/post_road/Index.html`）

