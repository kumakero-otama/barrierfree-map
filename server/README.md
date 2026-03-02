# server ディレクトリ構成

このディレクトリは、HTTPサーバー本体（`server.js`）から呼び出されるバックエンド処理を実装しています。  
ここでは `server/` 配下の各ファイルが何をしているかを、実装ベースで具体的に説明します。

## 全体像

- `server.js` でURLパスごとに `server/api/*.js` のハンドラを呼び分けます。
- DBアクセスは `server/db.js` の互換ラッパー経由で実行されます。
- ログは `server/logger.js` のCSVロガーで `logs/*.csv` に追記されます。
- API仕様書（OpenAPI）は `public/docs/openapi.yaml` に配置されています。
- Swagger UI は `https://barrierfree-map.loophole.site/docs/index.html`で閲覧できます。

---

## `server/` 直下

### `server/db.js`
- PostgreSQL接続を作る共通モジュールです。
- 主な役割:
  - `config.yaml` の `db` セクションを読み込み
  - `pg` の `Pool` を生成
  - 既存コード互換のため、`?` プレースホルダを PostgreSQL の `$1,$2...` に変換
  - `INSERT` 時に `RETURNING id` を自動補完し、`insertId` 風の戻り値に変換
- 返却:
  - `{ pool, error }` 形式（初期化失敗時は `pool: null`）

### `server/logger.js`
- CSV形式でログを追記する軽量ロガーです。
- 主な役割:
  - `createLogger(logFilePath)` でロガー生成
  - `appendLog(level, message)` で `timestamp,level,message` をCSV追記
  - ログディレクトリを自動作成

### `server/road_info_config.js`
- `config/road_info.yaml` から道情報投稿の設定を読むモジュールです。
- 主な役割:
  - `road_info.image_max_bytes` を読み込み
  - 不正値やファイル欠損時はデフォルト（2MB）にフォールバック
- 投稿API（`road_info.js`）と設定API（`config.js`）から利用されます。

---

## `server/api/` 一覧

### 認証方式（現行）
- 認証付きAPIは **Bearerトークン**（`Authorization: Bearer <token>`）を優先して受け付けます。
- 一部エンドポイントでは移行互換のため **session Cookie** でも認証可能です。
- 実装は `server/auth_token.js`（トークン生成/検証）と `server/auth_user.js`（ユーザー解決）にあります。

### `server/api/config.js`
- エンドポイント: `GET /api/config`
- 返す内容:
  - サーバー側最小送信間隔
  - クライアント側最小送信間隔
  - 道情報画像の最大サイズ（バイト）
- フロント側はこの値を使って投稿画像サイズ制限を行います。

### `server/api/count.js`
- エンドポイント: `GET /api/count`
- 返す内容:
  - 当月のマッチAPI利用回数
  - 月次上限
  - 全月のカウント情報
- `server.js` が保持する月次カウンタ状態をそのまま返します。

### `server/api/session.js`
- エンドポイント:
  - `POST /api/session/start`
  - `POST /api/session/end`
  - `POST /api/session/cancel`
- 主な役割:
  - セッション開始・終了の記録（`tactile.sessions`）
  - キャンセル時の関連データ削除
    - `tactile.session_path_edges`
    - `tactile.session_paths`
    - `tactile.gps_matched`
    - `tactile.gps_raw`
    - `tactile.sessions`
  - `canceledSessionIds` / `deletedSessionKeys` にも反映（後続保存を抑止）
- 認証:
  - Bearer または session Cookie が必要（未認証は `401`）
- ログ:
  - `logs/sessions.csv` にイベントを追記

### `server/api/records.js`
- エンドポイント: `GET /api/records`
- 主な役割:
  - `tactile.session_paths` から保存済み経路を取得
  - `centerLat/centerLng/radiusKm` があれば `ST_DWithin` で範囲絞り込み
  - `mine=1` 指定時はログインユーザーの経路のみ返却
  - `ST_AsGeoJSON(geom)` でフロントが扱いやすい形で返却
- 認証:
  - 通常取得は不要
  - `mine=1` 指定時のみ Bearer または session Cookie が必要

### `server/api/match_valhalla.js`（現行で使用）
- エンドポイント: `GET /api/match`
- 主な役割:
  - Valhalla `/locate` に座標を投げてスナップ位置を取得
  - レート制限（端末単位）を適用
  - 月次使用回数をカウント
  - 条件が揃うとセッション点を保存
  - `record=1` のときリアルタイム点を `gps_raw/gps_matched` に保存
- 依存:
  - 環境変数 `VALHALLA_HOST`, `VALHALLA_PORT`
  - DB（保存系）

### `server/api/trace.js`
- エンドポイント: `POST /api/trace`
- 主な役割:
  - Valhalla `/trace_attributes` を呼び出し、マッチング結果を返却
  - `sessionId` 付きなら `tactile.session_paths` と `tactile.session_path_edges` を更新
  - セッションがキャンセル済みなら保存をスキップ

### `server/api/osm_tactile.js`
- エンドポイント: `GET /api/osm-tactile-ways`
- 主な役割:
  - `config/osm_tactile_rules.yaml` を読み込み
  - Overpass APIへクエリ送信（中心座標 + 半径）
  - OSMレスポンスをGeoJSON `FeatureCollection` に整形して返却
- フロント地図の「OSM点字ブロック表示」トグルで利用されます。

### `server/api/post_tags.js`
- エンドポイント:
  - `GET /api/post-tags`（タグ一覧）
  - `POST /api/post-tags`（タグ追加）
- 主な役割:
  - `roadinfo.road_info_tag` をマスタとして参照
  - ラベル重複チェック
  - 新規作成時は `code` を自動生成（重複回避）
  - `sort_order` を末尾追加で採番

### `server/api/road_info.js`
- エンドポイント:
  - `GET /api/road-info?centerLat=...&centerLng=...&radiusKm=...`  
    道情報ポイント一覧（地図表示用）
  - `GET /api/road-info?pointId=...`  
    道情報詳細（タグ・投稿本文・画像）取得
  - `POST /api/road-info`  
    道情報投稿（ポイント・タグ関連付け・説明文・画像）
- 主な役割:
  - 投稿時:
    - `road_info_point` 追加
    - `road_info_point_tag` 追加
    - `road_info_note` 追加
    - `road_info_media` 追加
    - 画像を `uploads/road_info_media/` に保存
  - 失敗時:
    - DBトランザクションをロールバック
    - 保存済み画像ファイルを削除して整合性維持
- 認証:
  - `POST` は Bearer または session Cookie が必要
  - `GET` は通常不要（`mine=1` 指定時のみ必要）

### `server/api/google_auth.js`
- エンドポイント:
  - `POST /auth/google`（Google IDトークンでログイン）
  - `POST /auth/google/signup`（新規登録/初回プロフィール設定）
  - `GET /auth/me`（ログイン状態とユーザー情報取得）
  - `POST /auth/logout`（ログアウト）
  - `POST /auth/profile`（プロフィール更新）
- 主な役割:
  - Google IDトークン検証（`google-auth-library`）
  - アプリ用 Access Token（JWT）発行
  - session Cookie の発行/削除（互換運用）
  - `login.*` スキーマのユーザー/セッション管理
  - アイコン画像保存（`/uploads/user_icons/`）

### `server/api/match_mapbox.js`（現在未使用）
- 旧方式の `/api/match` 実装（Mapbox Matching API版）です。
- `server.js` は現在 `match_valhalla.js` を使用しているため、通常運用では呼ばれません。
- 互換・比較用として残されています。

---

## メンテ時の見る順番（推奨）

1. ルーティング確認: `server.js`
2. DB周り確認: `server/db.js`
3. 対象APIハンドラ: `server/api/*.js`
4. 設定値確認: `config.yaml`, `config/road_info.yaml`, `config/osm_tactile_rules.yaml`
