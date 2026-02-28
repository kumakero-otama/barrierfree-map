# Google OpenID Connect（Googleでログイン）導入まとめ（Google Cloud / Webアプリ向け）

最終更新: 2026-02-28 01:21:38

------------------------------------------------------------------------

## 🔰 まず理解しておくべき重要ポイント（追加整理）

### 1. Client IDはトークンではない

-   Client IDは「アプリの公開識別子」
-   トークンではない
-   有効期限なし
-   公開してOK
-   IDトークンの中の `aud` に入る値

### 2. IDトークンは「Googleアカウント × Client ID」に対して発行される

-   Client IDを指定しないとIDトークンは発行されない
-   IDトークンの `aud` はそのClient IDになる
-   サーバーは `aud == 自分のClient ID` を検証する

### 3. IDトークン取得時に事前トークンは不要

-   必要なのはClient IDのみ
-   ユーザーがGoogleで認証するとIDトークンが発行される
-   APIキーや事前トークンは不要

### 4. Googleアカウントとアプリユーザーの紐づけは `sub`

-   `sub` はGoogleユーザーの一意ID
-   名前やemailは識別キーに使わない
-   再ログイン時も `sub` で検索する

------------------------------------------------------------------------

## 全体方針（初心者向けシンプル構成）

1.  フロントでGoogleログイン
2.  IDトークンをバックエンドへ送信
3.  バックエンドでIDトークンを検証（署名・aud・exp）
4.  `sub` でユーザー検索
5.  なければ作成
6.  自前セッション（HTTPOnly Cookie）発行

------------------------------------------------------------------------

# 1. データベース設計（PostgreSQL）

CREATE SCHEMA IF NOT EXISTS login;

CREATE TABLE login.users ( user_id SERIAL PRIMARY KEY, username
VARCHAR(50), icon_url TEXT, total_tactile_length NUMERIC(10,3) DEFAULT
0, total_road_posts INTEGER DEFAULT 0, total_hearts INTEGER DEFAULT 0,
is_active BOOLEAN DEFAULT TRUE, email_verified BOOLEAN DEFAULT FALSE,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP
DEFAULT CURRENT_TIMESTAMP, last_login_at TIMESTAMP );

CREATE TABLE login.user_auth_providers ( auth_id SERIAL PRIMARY KEY,
user_id INTEGER NOT NULL REFERENCES login.users(user_id) ON DELETE
CASCADE, provider VARCHAR(20) NOT NULL CHECK (provider IN
('email','google')), provider_user_id TEXT, email VARCHAR(255),
password_hash TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT chk_uap_fields_by_provider CHECK ( (provider='email' AND
email IS NOT NULL AND password_hash IS NOT NULL AND provider_user_id IS
NULL) OR (provider='google' AND provider_user_id IS NOT NULL AND
password_hash IS NULL) ) );

CREATE UNIQUE INDEX uix_uap_email_only ON login.user_auth_providers
(email) WHERE provider = 'email';

CREATE UNIQUE INDEX uix_uap_google_sub ON login.user_auth_providers
(provider_user_id) WHERE provider = 'google';

------------------------------------------------------------------------

# 2. 認証フロー整理

① フロントがClient IDを使ってGoogleログイン開始\
② ユーザーがGoogleで認証\
③ GoogleがIDトークン（JWT）発行\
④ フロントがバックエンドへ送信\
⑤ バックエンドが署名検証\
⑥ payload.sub を取得\
⑦ DB検索\
⑧ セッションCookie発行

------------------------------------------------------------------------

# 3. IDトークン検証の本質

サーバーはGoogle公開鍵で署名を検証する。

-   署名が正しいか
-   audが自分のClient IDか
-   有効期限内か

Googleに毎回問い合わせるわけではない。

------------------------------------------------------------------------

# 4. 紐づけロジック

初回ログイン： - subが存在しない → user作成 + google provider作成

再ログイン： - subが存在 → 同一user_idでログイン

nameやemailは表示用。識別キーではない。

------------------------------------------------------------------------

# 5. セキュリティ要点

-   IDトークンは毎回APIに使わない
-   ログイン確定後は自前セッション
-   CookieはHttpOnly
-   本番はSecure=true
-   フロントでJWTを信用しない

------------------------------------------------------------------------

# 6. Google Cloud設定まとめ

1.  プロジェクト作成
2.  OAuth同意画面設定
3.  OAuth Client ID作成（Web application）
4.  JavaScript origins設定
5.  Client IDをフロントへ設定
6.  バックエンドでaudience検証

APIキーはログインには不要。

------------------------------------------------------------------------

# 7. まとめ

✔ Client IDはアプリ識別子（トークンではない）\
✔ IDトークンはGoogleが発行するJWT\
✔ IDトークンはClient ID向けに発行される\
✔ アカウント紐づけはsubで行う\
✔ 再ログイン時もsubで確定\
✔ ログイン後はHTTPOnlyセッションで管理

------------------------------------------------------------------------
