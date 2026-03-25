# API List

参照元: `public/docs/openapi.yaml`  
OpenAPI version: `3.0.3`  
API version: `1.23.0`

## 認証

- 認証付きAPIは `Authorization: Bearer <token>` または `session` Cookie を使用します。
- OpenAPI上の security 指定がないAPIは、原則として未認証で利用できます。

## API 一覧

| Method | Path | Auth | 概要 |
| --- | --- | --- | --- |
| GET | `/api/config` | 不要 | クライアント初期化用設定を取得 |
| GET | `/api/count` | 不要 | マップマッチング月次カウントを取得 |
| GET | `/api/match` | 不要 | 1点マップマッチング（Valhalla locate） |
| POST | `/api/session/start` | 必要 | セッション開始 |
| POST | `/api/session/end` | 必要 | セッション終了 |
| POST | `/api/session/cancel` | 必要 | セッション関連データを削除 |
| POST | `/api/session/deactivate` | 必要 | セッションを論理無効化 |
| POST | `/api/session/memo` | 必要 | セッションメモを更新 |
| GET | `/api/records` | 条件付き | 保存済み経路一覧を取得 |
| POST | `/api/trace` | 不要 | Valhalla `trace_attributes` を呼び出し |
| GET | `/api/osm-tactile-ways` | 不要 | Overpass経由で点字ブロック関連地物を取得 |
| GET | `/api/post-tags` | 不要 | 投稿タグ一覧を取得 |
| POST | `/api/post-tags` | 不要 | 投稿タグを追加 |
| GET | `/api/road-info` | 条件付き | 道情報の一覧または詳細を取得 |
| POST | `/api/road-info` | 必要 | 道情報を投稿 |
| GET | `/api/pro-status` | 必要 | 現在ログイン中ユーザーのPRO状態を取得 |
| PUT | `/api/pro-status` | 必要 | 現在ログイン中ユーザーのPRO状態を更新 |
| GET | `/api/tactile-tags` | 不要 | `tactile.tags` 一覧を取得 |
| POST | `/api/tactile-tags` | 必要 | `tactile.tags` にタグを追加 |
| GET | `/api/session-tags` | 必要 | 現在ログイン中ユーザーの `tactile.session_tags` 一覧を取得 |
| POST | `/api/session-tags` | 必要 | `tactile.session_tags` に紐づけを追加 |
| GET | `/api/tactile-session-info` | 不要 | `session_id` から記録ユーザー情報とタグ表示名を取得 |
| POST | `/auth/google` | 不要 | Google IDトークンでログイン |
| POST | `/auth/google/signup` | 不要 | Googleアカウントで新規登録またはプロフィール初期設定 |
| GET | `/auth/me` | 必要 | ログインユーザー情報を取得 |
| POST | `/auth/logout` | 必要 | ログアウト |
| POST | `/auth/profile` | 必要 | ユーザープロフィール更新 |

注記:
- `GET /api/records` は OpenAPI 上で security 指定があります。実装上は `mine=1` 指定時に認証が必要になる想定です。
- `GET /api/road-info` は OpenAPI 上で security 指定があります。実装上は `mine=1` 指定時など、一部条件で認証が必要になる想定です。

## エンドポイント詳細

### Config / Match

#### `GET /api/config`
- 概要: クライアント初期化用設定を取得
- 主なレスポンス:
  - `200`: `serverMinIntervalMs`, `clientMinIntervalMs`, `roadInfoImageMaxBytes`
  - `405`: `method_not_allowed`

#### `GET /api/count`
- 概要: マップマッチング月次カウントを取得
- 主なレスポンス:
  - `200`: `count`, `max`, `month`, `allMonths`
  - `405`: `method_not_allowed`

#### `GET /api/match`
- 概要: 1点マップマッチング（Valhalla locate）
- 主なクエリ:
  - 必須: `lat`, `lng`
  - 任意: `prevLat`, `prevLng`, `sessionId`, `sessionUuid`, `userId`, `deviceUuid`, `seq`, `record=1`
- 主なレスポンス:
  - `200`: `lat`, `lng`, `count`, `month`
  - `204`: 上限到達または上流応答を処理できない場合
  - `400`: `invalid_coordinates`
  - `429`: `rate_limited`

### Session / Records / Trace

#### `POST /api/session/start`
- 概要: セッション開始
- 認証: 必要
- リクエストBody:
  - 任意: `sessionId`, `sessionUuid`, `startedAt`
- 主なレスポンス:
  - `200`: `success`, `sessionId` など
  - `400`, `401`, `500`

#### `POST /api/session/end`
- 概要: セッション終了
- 認証: 必要
- リクエストBody:
  - 任意: `sessionId`, `sessionUuid`, `endedAt`
- 主なレスポンス:
  - `200`: `success`, `sessionId`, `updated` など
  - `400`, `401`, `500`

#### `POST /api/session/cancel`
- 概要: セッション関連データを削除
- 認証: 必要
- リクエストBody:
  - 任意: `sessionId`, `sessionUuid`
- 主なレスポンス:
  - `200`: `success`, `sessionId`, `canceled` など
  - `400`, `401`, `404`, `500`

#### `POST /api/session/deactivate`
- 概要: セッションを論理無効化
- 認証: 必要
- リクエストBody:
  - 任意: `sessionId`, `sessionUuid`
- 補足:
  - `tactile.sessions.is_active` を `false` に更新
  - `session_paths` などの関連データは削除しない
- 主なレスポンス:
  - `200`: `success`, `sessionId`, `updated` など
  - `400`, `401`, `404`, `500`

#### `POST /api/session/memo`
- 概要: セッションメモを更新
- 認証: 必要
- リクエストBody:
  - 任意: `sessionId`, `sessionUuid`
  - 必須: `memo`
- 補足:
  - `tactile.sessions.memo` を送信文字列で上書きする
  - 空文字を送るとメモを空にできる
- 主なレスポンス:
  - `200`: `success`, `sessionId`, `memo`, `updated` など
  - `400`, `401`, `404`, `500`

#### `GET /api/records`
- 概要: 保存済み経路一覧を取得
- 認証: 条件付き
- 主なクエリ:
  - 任意: `centerLat`, `centerLng`, `radiusKm`, `mine=1`
- 主なレスポンス:
  - `200`: `success`, `count`, `paths[]`
  - `401`, `405`, `500`, `503`

#### `POST /api/trace`
- 概要: Valhalla `trace_attributes` を呼び出し
- リクエストBody:
  - 必須: `shape[]`
  - 任意: `userId`, `sessionId`, `source`, `costing`, `shape_match`, `filters`
- 主なレスポンス:
  - `200`: Valhallaレスポンスを返却
  - `400`: `invalid_json`
  - `405`, `500`

### OSM / RoadInfo / Tags

#### `GET /api/osm-tactile-ways`
- 概要: Overpass経由で点字ブロック関連地物を取得
- 主なクエリ:
  - 必須: `centerLat`, `centerLng`
  - 任意: `radiusKm`（既定値 `10`）
- 主なレスポンス:
  - `200`: `success`, `centerLat`, `centerLng`, `radiusKm`, `count`, `features[]`
  - `400`: `invalid_center`
  - `405`, `500`, `502`

#### `GET /api/post-tags`
- 概要: 投稿タグ一覧を取得
- 主なレスポンス:
  - `200`: `success`, `count`, `tags[]`
  - `405`, `500`, `503`

#### `POST /api/post-tags`
- 概要: 投稿タグを追加
- リクエストBody:
  - 必須: `label`
- 主なレスポンス:
  - `200`: 既存タグを返却
  - `201`: 新規作成
  - `400`, `405`, `500`, `503`

#### `GET /api/road-info`
- 概要: 道情報の一覧または詳細を取得
- 認証: 条件付き
- 主なクエリ:
  - 一覧: `centerLat`, `centerLng`, `radiusKm`, `mine=1`
  - 詳細: `pointId`
- 補足:
  - 一覧取得では `status = active` のポイントのみ返却
  - 詳細取得でも `status = deleted` のポイントは返却しない
- 主なレスポンス:
  - `200`: 一覧レスポンスまたは詳細レスポンス
  - `400`, `401`, `404`, `405`, `500`, `503`

#### `POST /api/road-info`
- 概要: 道情報を投稿（タグ自動作成対応）
- 認証: 必要
- リクエストBody:
  - 任意: `pointId`, `lat`, `lng`, `detail`, `tagIds[]`, `status`, `images[]`
- 補足:
  - 未登録の `tagIds` は自動作成される
  - 完了系タグが含まれる場合、対象ポイントの `status` は `inactive` に更新される
  - `status = deleted` 指定時は status 更新のみ行い、note / media / tag の追加は行わない
- 主なレスポンス:
  - `201`: `success`, `pointId`, `noteId`, `tagsCount`, `createdTags[]`, `mediaCount`
  - `400`, `401`, `404`, `405`, `500`, `503`

### ProStatus / Tactile

#### `GET /api/pro-status`
- 概要: 現在ログイン中ユーザーのPRO状態を取得
- 認証: 必要
- 主なレスポンス:
  - `200`: `ProStatusResponse`
  - `401`, `404`, `405`, `503`

#### `PUT /api/pro-status`
- 概要: 現在ログイン中ユーザーのPRO状態を更新
- 認証: 必要
- リクエストBody:
  - 必須: `isPro`
- 主なレスポンス:
  - `200`: `ok` を含む `ProStatusResponse`
  - `400`, `401`, `404`, `405`, `503`

#### `GET /api/tactile-tags`
- 概要: `tactile.tags` 一覧を取得
- 主なクエリ:
  - 任意: `activeOnly=1|true`
- 主なレスポンス:
  - `200`: `success`, `count`, `tags[]`
  - `405`, `503`

#### `POST /api/tactile-tags`
- 概要: `tactile.tags` にタグを追加
- 認証: 必要
- リクエストBody:
  - 必須: `code`, `labelJa`
  - 任意: `sortOrder`, `isActive`
- 主なレスポンス:
  - `200`: 既存タグ
  - `201`: 新規作成
  - `400`, `401`, `405`, `500`, `503`

#### `GET /api/session-tags`
- 概要: 現在ログイン中ユーザーの `tactile.session_tags` 一覧を取得
- 認証: 必要
- 主なクエリ:
  - 任意: `sessionId`, `sessionUuid`
- 主なレスポンス:
  - `200`: `success`, `count`, `sessionTags[]`
  - `401`, `405`, `500`, `503`

#### `POST /api/session-tags`
- 概要: `tactile.session_tags` に紐づけを追加
- 認証: 必要
- リクエストBody:
  - 必須: `sessionId`
  - 任意: `sessionUuid`, `tagId`, `tagCode`
- 主なレスポンス:
  - `200`: 既存紐づけ
  - `201`: 新規作成
  - `400`, `401`, `404`, `405`, `500`, `503`

#### `GET /api/tactile-session-info`
- 概要: `session_id` から記録ユーザー情報、メモ、タグ表示名を取得
- 主なクエリ:
  - 必須相当: `sessionId` または `sessionUuid`
- 主なレスポンス:
  - `200`: `success`, `session`
  - `400`, `404`, `405`, `500`, `503`

### Auth

#### `POST /auth/google`
- 概要: Google IDトークンでログイン
- リクエストBody:
  - 必須: `id_token`
- 主なレスポンス:
  - `200`: 認証成功、`Set-Cookie` を返す
  - `400`, `401`, `404`, `405`, `500`

#### `POST /auth/google/signup`
- 概要: Googleアカウントで新規登録またはプロフィール初期設定
- リクエストBody:
  - 必須: `id_token`, `username`, `icon_data_url`
- 主なレスポンス:
  - `200`: 認証成功、`updated` を含む。`Set-Cookie` を返す
  - `400`, `401`, `405`, `500`

#### `GET /auth/me`
- 概要: ログインユーザー情報を取得
- 認証: 必要
- 主なレスポンス:
  - `200`: `authenticated: true`, `user`
  - `401`: `authenticated: false`
  - `405`

#### `POST /auth/logout`
- 概要: ログアウト
- 認証: 必要
- 主なレスポンス:
  - `200`: `ok: true`、Cookie削除
  - `401`, `405`

#### `POST /auth/profile`
- 概要: ユーザープロフィール更新
- 認証: 必要
- リクエストBody:
  - 必須: `username`
  - 任意: `icon_data_url`
- 主なレスポンス:
  - `200`: `ok`, `user`
  - `400`, `401`, `404`, `405`, `500`
