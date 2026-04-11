# サーバー通信安定化対策メモ

## 背景

Google ログインおよびサーバー通信全般で、以下の不安定な挙動が確認された。

- Google アカウント選択後にログイン画面へ戻る
- 一部試行では `POST /auth/google` がサーバーへ到達していない
- 一部試行では `GET /auth/me` は届くが、`Authorization` も `session Cookie` も付かず `401` になる
- 起動直後は通るが、しばらく使用すると再び通じなくなる
- 外部公開 URL は一時的に応答しなくなるが、後で自然回復することがある
- 認証以外の API 通信でも、公開経路や外部依存先の影響を受ける
- `loophole` 側では `EOF` やトンネル再接続エラーが発生していた
- `loophole` 側で DNS 解決失敗や TLS handshake error も発生していた
- PM2 標準出力ログが肥大化していた
- 最終的には `loophole` 再起動に加えてサーバー再起動後に正常化した

このため、問題は単一原因ではなく、以下が重なっていた可能性が高い。

- フロントでの認証状態保持または通信失敗時の制御の弱さ
- フロント側ログ回収不足
- サーバーの認証ログ・通信ログ可観測性不足
- 公開経路 (`loophole`) の不安定さ
- 外部依存先 API の一時障害
- 標準出力ログ肥大による I/O 負荷
- サーバープロセス長時間稼働時の状態不整合

## 対策の前提

今回の対策対象は認証通信だけではない。以下をすべて「サーバー通信」として扱う。

- `/auth/*`
- `/api/*`
- `loophole` を介した外部公開経路
- DB 接続
- 外部 API 依存通信
- フロントからサーバーへの `fetch` / `authFetch`

## フロントエンド対策

### 1. 通信フロー全般のデバッグログを追加する

最低限、以下の地点でログを出す。

- 各画面の初期化開始
- `fetch` / `authFetch` の送信直前
- 応答受信直後
- HTTP ステータス
- timeout / abort / network error
- 画面遷移開始
- ログイン関連では Google credential callback 開始
- Google credential callback 開始
- `POST /auth/google` 送信直前
- `POST /auth/google` 応答受信直後
- 応答 JSON 内の `access_token` 有無
- `localStorage` への保存直後
- `GET /auth/me` 送信直前
- `GET /auth/me` のステータス受信直後

目的:

- 「どの API が送信前で止まったか」
- 「送信したが応答が返らなかったか」
- 「レスポンスは返ったが画面側処理で止まったか」
- 「Google 認証後に `/auth/google` 自体が飛んでいない」
- 「`access_token` を受け取ったが保存できていない」
- 「`/auth/me` に Authorization を付けずに送っている」

のどれかを切り分けるため。

### 1-2. フロント側ログ回収の仕組みを作る

ブラウザ console を目視するだけでは、現地端末で起きた認証失敗を後から追いにくい。

対策:

- 通信系イベントをメモリまたは `sessionStorage` に一時保持する
- 必要時に JSON として画面からコピーできるようにする
- 将来的にはデバッグ用 API に送信できる形にする

最低限回収したい項目:

- 発生時刻
- event 名
- request id
- 画面 URL
- user agent
- API path
- method
- timeout 発生有無
- response status
- network error 内容
- `/auth/google` の送信開始・応答受信・失敗
- `/auth/me` の送信開始・応答ステータス・失敗
- `/api/*` の送信開始・応答受信・失敗
- `access_token` 受信有無
- `localStorage` 保存成功可否
- ログイン画面へ戻した理由

目的:

- サーバーログに出ない「送信前で止まったケース」を特定する
- ユーザー端末ごとの差異を追跡できるようにする
- 認証以外の API 詰まりも追跡できるようにする

### 1-2-1. フロント側ログは `IndexedDB` に永続キュー保存する

`sessionStorage` やメモリ保持だけでは、アプリ再起動やブラウザ再読み込み後に消えてしまう。
そのため、実運用で回収したい通信ログはブラウザ内 DB である `IndexedDB` に保持する。

対策:

- フロント側通信ログの保存先は原則 `IndexedDB` とする
- `sessionStorage` やメモリ保持は即時表示用の補助とし、永続保存の主経路にはしない
- ログは未送信キューとして保存し、アプリ再起動後も読み出せるようにする
- 通信復旧時に未送信ログをサーバへまとめて送信する
- 送信成功したログだけを `IndexedDB` から削除する
- 保存件数・保存期間の上限を決め、古いログはローテーションする

最低限の保存項目:

- `logId`
- `createdAt`
- `sentAt`
- `retryCount`
- `requestId`
- `sessionId` または起動単位ID
- `screen`
- `event`
- `path`
- `method`
- `status`
- `timeout`
- `networkError`
- `hasAuthorization`
- `hasAccessToken`
- `debugFlags`

再送仕様:

- アプリ起動時に未送信ログキューを読み込む
- `online` イベント発生時に再送を試みる
- 画面初期化後の一定時間後にも再送を試みる
- 送信中に失敗した場合はキューを残し、次回再試行する
- 同一ログの重複送信を避けるため、`logId` を不変IDとして持たせる

サーバ連携前提:

- フロント側ログ送信用の API を別途用意する
- 受信 API はログ配列をまとめて受け取れるようにする
- サーバ側でも `logId` と `requestId` を保持し、重複受信を識別できるようにする

注意:

- `IndexedDB` はブラウザ内のローカル保存であり、サーバ DB ではない
- ユーザーがブラウザデータを削除した場合はログも消える
- `access_token` や個人情報そのものはログ本文に保存しない
- 保存するのは有無、長さ、付与状態、エラー分類など最小限のメタ情報に留める

### 1-3. デバッグログを有効化しやすくする

常時大量ログを出すのではなく、必要時だけ有効にできるようにする。

対策:

- `?debug_network=1` や `?debug_auth=1` のようなクエリで有効化する
- あるいは `localStorage` フラグで有効化する
- 有効時のみ詳細ログを console とローカル保存へ出す

目的:

- 通常利用時のノイズを避ける
- 障害再現時だけ詳細追跡できるようにする

### 2. 共通通信ラッパーを作る

現状は各画面が個別に `fetch` / `authFetch` を持っており、timeout・retry・ログ形式が揃っていない。

対策:

- 通信用の共通ラッパーを作る
- 以下を共通実装する
  - request id 付与
  - timeout
  - エラー分類
  - デバッグログ
  - 軽い再試行

目的:

- 画面ごとに通信挙動がばらつくのを防ぐ
- 切り分けを容易にする

### 3. `access_token` 保存失敗を明示的に扱う

現状は `localStorage` 保存失敗が画面上で見えにくい。

対策:

- `setAccessToken()` の直後に `getAccessToken()` を確認する
- 保存できていなければ `/auth/me` へ進まずエラー表示する
- エラー内容は「認証情報の保存に失敗しました」と明示する

### 4. `/auth/me` の失敗理由を画面上で分ける

現状は未認証時にログイン画面へ戻るため、原因が見えにくい。

対策:

- `401/403` と通信失敗を分けて表示する
- `/auth/me` の `401/403` 時は「認証情報がサーバーに届いていません」
- ネットワーク失敗時は「通信に失敗しました。再試行してください」

### 5. 一時通信失敗で即ログアウトしすぎない

認証確認が1回失敗しただけで即ログイン画面へ戻すと、トンネル不安定時に体験が悪化する。

対策:

- `fetch` 例外やタイムアウト時は 1 回だけリトライする
- 即時 `clearAccessToken()` せず、通信失敗と未認証を分ける
- 連続失敗時のみログイン画面へ戻す

### 6. API 通信ごとの timeout と retry 方針を決める

API によって timeout を分ける。

例:

- `/auth/*`: 短め
- `/api/config` や `/api/pro-status`: 中程度
- `/api/match`, `/api/trace`, `/api/osm-tactile-ways`: 長め

対策:

- timeout をエンドポイント別に設定する
- idempotent な GET は 1 回再試行する
- POST は安易に再送せず、ユーザー操作に委ねる

### 7. リクエスト相関IDを付与する

フロントから認証リクエストごとに request id を付ける。

例:

- `X-Request-Id`
- またはクエリ文字列・ログ専用ID

目的:

- ブラウザログとサーバーログを 1 試行単位で追跡できるようにする
- フロント側ログ回収結果とバックエンドログを突き合わせやすくする

## バックエンド対策

### 1. 通信ログを構造化して残す

認証だけでなく、主要 API の通信ログを同じ形式で追えるようにする。

対策:

- `auth.csv` に加えて `api.csv` も用意する
- 少なくとも以下を 1 行に残す
  - timestamp
  - request id
  - path
  - method
  - status
  - duration_ms
  - user id
  - hasAuthorization
  - hasCookie
  - error message

目的:

- どの API が遅いか、落ちるか、届いていないかを追うため
- 認証以外の通信不安定も切り分けるため

### 2. 認証ログを詳細化する

今回、認証イベントは `console.log` で見えているが、通常の CSV ログと切り分けて追いづらい。

対策:

- `auth.csv` など認証専用ログを作る
- 以下を 1 行に残す
  - timestamp
  - event
  - path
  - method
  - request id
  - user id
  - email
  - hasAuthorization
  - hasCookie
  - response status
  - error message

### 3. `/auth/google` 応答内容を明示ログ化する

少なくとも以下を記録する。

- `access_token` を返したか
- `Set-Cookie` を設定したか
- `userId`
- `email`

目的:

- ログイン成功と、その後の `/auth/me` 失敗の差を追うため

### 4. `/auth/me` 失敗時の内訳を細かくする

現状は `me_unauthenticated` でまとまっている。

対策:

- `missing_authorization_and_cookie`
- `invalid_access_token`
- `expired_access_token`
- `session_cookie_not_found`
- `session_expired`
- `user_not_found`

など、原因別にログイベントを分ける。

### 5. `/api/*` の遅延と失敗を見える化する

認証以外でも、通信不安定の影響を受ける API がある。

対策:

- `/api/match`
- `/api/trace`
- `/api/records`
- `/api/osm-tactile-ways`
- `/api/road-info`
- `/api/session/*`

について、処理時間と失敗理由を記録する。

特に見たい項目:

- duration_ms
- upstream error
- DB error
- timeout
- client abort

### 6. 外部依存通信に timeout とフォールバックを入れる

今回のログでは以下が継続的に失敗している。

- Overpass API: `504`, `429`
- レコード取得系: `Connection terminated unexpectedly`

対策:

- 外部 API 呼び出しに timeout を付ける
- 失敗時は即全体障害にせず、空配列や縮退レスポンスへ落とす
- 短時間に失敗が続く場合はキャッシュへ切り替える

### 7. ヘルスチェック API を追加する

例:

- `GET /healthz`
- `GET /healthz/auth`
- `GET /healthz/db`
- `GET /healthz/upstream`

確認内容:

- サーバープロセスが応答しているか
- DB 接続が生きているか
- 認証用テーブルへ最低限アクセスできるか
- 外部依存先へ最低限アクセスできるか

目的:

- 「サーバーは online だが通信の一部が不調」を検知しやすくする

### 8. 長時間稼働時の自己回復を入れる

今回、サーバー再起動後に認証が正常化した。

対策:

- PM2 のメモリ閾値再起動
- 定期ヘルスチェックで異常時に自動再起動
- 少なくとも認証障害時に手動再起動しやすい運用手順を作る

### 9. 標準出力ログを削減する

現状、PM2 の `barrierfree-map-server-out.log` が巨大化している。

対策:

- 巨大レスポンス本文を `console.log` しない
- Valhalla や外部 API の全文レスポンス出力をやめる
- 必要なら件数・サイズ・先頭数十文字だけ記録する

目的:

- I/O 負荷を減らす
- PM2 ログ肥大を抑える

### 10. `/auth/google` と `/auth/me` のレスポンス監視を入れる

例:

- `401/403` の件数
- `login_failed` 件数
- `me_unauthenticated` 件数
- `/auth/google` 成功直後の `/auth/me` 失敗件数

目的:

- 障害発生時に「今どこで落ちているか」を即判断するため

### 11. プロセスとログの定常監視を入れる

対策:

- メモリ
- FD 数
- PM2 ログサイズ
- 再起動回数
- 直近の `500`, `401`, timeout 件数

を定期監視する。

目的:

- 「しばらく使うと悪くなる」兆候を事前に捕まえるため

## 公開経路・運用対策

### 1. `loophole` の死活監視を入れる

今回 `loophole` に以下が出ていた。

- `EOF Connection dropped, reconnecting...`
- `Listening on remote endpoint for HTTPS failed`
- `Tunnel startup error error=EOF`
- `Temporary failure in name resolution`
- `TLS handshake error ... bad record MAC`

対策:

- `loophole` のログ監視
- 異常時の自動再起動
- 外形監視で公開 URL の疎通確認

### 2. グローバル疎通の外形監視を入れる

定期的に公開 URL へアクセスし、以下を確認する。

- TCP 接続可否
- HTTPS 応答有無
- 期待するステータス
- 応答時間

目的:

- 「フロントから見て落ちている」状態をサーバー側でも即検知するため

### 3. 障害時の再起動手順を定義する

最低限、以下を運用手順として固定する。

1. `pm2 list`
2. `barrierfree-map-loophole` 再起動
3. 改善しなければ `barrierfree-map-server` 再起動
4. 直後に公開 URL 疎通確認
5. 直後に認証ログ差分確認

### 4. PM2 ログのローテーションを導入する

現状の PM2 ログは肥大し続ける。

対策:

- PM2 logrotate 導入
- サイズ上限設定
- 保存世代数設定

### 5. VPS 移行を中長期の本命対策とする

`loophole` は簡易公開には便利だが、認証のような安定性要求が高い経路には不利。

VPS 化で改善が見込める点:

- トンネル依存がなくなる
- HTTPS 終端を固定化できる
- 常時稼働で公開経路が安定する
- 再起動や監視をサーバー側で完結できる

結論:

- `loophole` より VPS のほうが安定する可能性は高い
- 特に Google ログインや継続的な API 利用を含む構成では、VPS の方が本番運用向き

## 優先順位

### すぐやる

- フロントで通信系ログ回収を入れる
- 共通通信ラッパーに request id と timeout を入れる
- バックエンドで認証ログと API 通信ログを構造化する
- 巨大 `console.log` を削減する
- `loophole` とサーバーの再起動手順を文書化する
- PM2 ログローテーションを入れる

### 次にやる

- `/healthz` 系 API を追加する
- `me_unauthenticated` の原因内訳を詳細化する
- GET 系 API の軽い再試行制御を導入する
- グローバル疎通の外形監視を入れる

### 中長期

- `loophole` 依存をやめて VPS へ移行する
- 外形監視と自動復旧を導入する
- 外部依存通信のキャッシュ・縮退運用を整える

## フロント側ログ回収 API 仕様

この章は、フロント実装を進めるための通信仕様を定義する。
目的は、ブラウザ内に蓄積した通信ログをサーバーへ安全に回収し、
バックエンドログと突き合わせられるようにすること。

### API 一覧

- `POST /api/client-logs`
  - フロント側で蓄積したログをまとめて送信する
- `GET /api/client-logs/health`
  - ログ受信 API の到達確認を行う

### `POST /api/client-logs`

#### 目的

- `IndexedDB` に保存した未送信ログをまとめて回収する
- 障害再現後のブラウザ側イベント列をサーバーへ送る

#### リクエストヘッダ

- `Content-Type: application/json`
- `X-Request-Id: <uuid or unique string>`

任意:

- `Authorization: Bearer <token>`
  - 送信できる場合は付与する
  - 未ログイン状態でも送信できるように、この API 自体は Authorization 必須にしない

#### リクエストボディ

```json
{
  "client": {
    "appVersion": "1.24.1",
    "userAgent": "Mozilla/5.0 ...",
    "platform": "Android",
    "language": "ja-JP",
    "online": true,
    "pageUrl": "https://kumakero-otama.github.io/auth/login.html",
    "referrer": "https://kumakero-otama.github.io/",
    "screen": {
      "width": 412,
      "height": 915,
      "devicePixelRatio": 2.625
    }
  },
  "session": {
    "clientSessionId": "3e1d1e6a-7c4b-4f42-8f1c-1e4e6e9c4ab1",
    "requestId": "56d5c5d7-907f-4f40-8ab8-2ee9f0f4af82",
    "debugFlags": {
      "debugNetwork": true,
      "debugAuth": true
    }
  },
  "logs": [
    {
      "logId": "01JS7P4JQ12S4JQ2D4Q3M6S6BZ",
      "createdAt": "2026-04-11T06:55:31.112Z",
      "sentAt": null,
      "retryCount": 0,
      "screen": "auth/login",
      "event": "auth_google_request_start",
      "category": "auth",
      "path": "/auth/google",
      "method": "POST",
      "status": null,
      "durationMs": null,
      "timeout": false,
      "networkError": null,
      "hasAuthorization": false,
      "hasAccessToken": false,
      "hasCookie": false,
      "message": "sending google login request",
      "meta": {
        "googleCredentialReceived": true
      }
    }
  ]
}
```

#### フィールド定義

`client`

- `appVersion`: フロント側バージョン
- `userAgent`: ブラウザ UA
- `platform`: OS または端末種別
- `language`: 言語設定
- `online`: `navigator.onLine`
- `pageUrl`: 発生画面 URL
- `referrer`: 遷移元
- `screen`: 画面サイズ情報

`session`

- `clientSessionId`: アプリ起動単位またはブラウザタブ単位の ID
- `requestId`: 送信バッチ単位の ID
- `debugFlags`: デバッグ有効状態

`logs[]`

- `logId`: フロント側で一意な不変 ID
- `createdAt`: ログ発生時刻
- `sentAt`: 送信時刻。未送信時は `null`
- `retryCount`: 再送回数
- `screen`: 画面識別子
- `event`: イベント名
- `category`: `auth`, `api`, `navigation`, `storage`, `network`
- `path`: API パスまたは関連 URL
- `method`: HTTP メソッド
- `status`: HTTP ステータス。未取得時は `null`
- `durationMs`: レスポンス受信までの時間
- `timeout`: timeout 発生有無
- `networkError`: fetch 例外やネットワークエラー名
- `hasAuthorization`: Authorization を付けたか
- `hasAccessToken`: access token を保持していたか
- `hasCookie`: cookie が見えていたかをフロントで把握できる範囲で記録
- `message`: 簡単な補足
- `meta`: イベント固有の追加情報

#### 保存禁止項目

以下はログ本文に保存しない。

- `access_token` の実値
- Google ID token の実値
- Cookie の実値
- 個人情報本文
- 画像データ

保存してよいのは以下に留める。

- token があったかどうか
- 文字列長
- 付与状態
- エラー分類

#### レスポンス

成功時:

```json
{
  "ok": true,
  "accepted": 12,
  "duplicate": 0,
  "rejected": 0,
  "serverRequestId": "srv-20260411-000123"
}
```

部分成功時:

```json
{
  "ok": true,
  "accepted": 10,
  "duplicate": 2,
  "rejected": 1,
  "errors": [
    {
      "logId": "01JS7P4JQ12S4JQ2D4Q3M6S6BZ",
      "reason": "invalid_created_at"
    }
  ],
  "serverRequestId": "srv-20260411-000124"
}
```

失敗時:

```json
{
  "ok": false,
  "error": "invalid_payload"
}
```

#### ステータスコード

- `200`: 正常受理
- `207`: 一部受理、一部拒否
- `400`: 不正な JSON または必須項目欠落
- `413`: 1 回の送信件数またはサイズが上限超過
- `429`: 短時間の送信回数超過
- `500`: サーバー内部エラー

### `GET /api/client-logs/health`

#### 目的

- フロント側から「ログ送信 API が使えるか」を軽く確認する

#### レスポンス

```json
{
  "ok": true
}
```

### フロント側送信仕様

- 送信単位は 1 バッチ最大 `100` 件まで
- リクエストサイズ上限は暫定 `256KB`
- `online` イベント時に再送を試みる
- アプリ起動時に未送信ログを読み込み、数秒後に再送する
- 認証失敗や通信失敗直後にも再送を試みてよい
- 成功応答で `accepted + duplicate` 扱いになった `logId` は削除対象にする
- `429`, `500`, `fetch` 例外時はキューを残す

### サーバー側受信仕様

- `logId` で重複排除する
- `requestId` 単位でも追跡できるようにする
- 保存先は `client_logs` テーブルまたは専用ログファイルとする
- 少なくとも以下で検索できるようにする
  - `createdAt`
  - `logId`
  - `requestId`
  - `clientSessionId`
  - `event`
  - `path`
  - `status`

### 推奨イベント名

認証系:

- `auth_google_callback_start`
- `auth_google_request_start`
- `auth_google_response_received`
- `auth_google_response_error`
- `auth_access_token_saved`
- `auth_access_token_save_failed`
- `auth_me_request_start`
- `auth_me_response_received`
- `auth_me_unauthorized`
- `auth_redirect_login`

API系:

- `api_request_start`
- `api_response_received`
- `api_response_error`
- `api_timeout`
- `api_retry_scheduled`

画面遷移系:

- `navigation_start`
- `navigation_replace`
- `navigation_redirect_login`

保存系:

- `storage_read`
- `storage_write`
- `storage_delete`
- `indexeddb_queue_enqueue`
- `indexeddb_queue_flush_start`
- `indexeddb_queue_flush_success`
- `indexeddb_queue_flush_failed`
