# Google OpenID Connect（Googleでログイン）導入まとめ（Google Cloud / Webアプリ向け）

> **初期設計資料:** 現行実装の設定名と再現手順は[`../REPRODUCTION.md`](../REPRODUCTION.md)、実際の処理は`server/api/google_auth.js`を参照してください。シークレット実値をGitへ保存しないでください。

このドキュメントは、あなたのオリジナルアプリに **Google OpenID Connect（OIDC）** を使ったログイン機能を、**初心者向けにシンプル**に実装するための方針・DB設計・フロント/バックの変更点・Google Cloud設定手順をまとめたものです。

---

## 方針（結論）

私のおすすめは **「フロントでGoogleログイン → バックエンドでIDトークン検証 → 自アプリのセッション（HTTPOnly Cookie）発行」** です。

- Googleが返す **IDトークン（JWT）** は「本人確認」に使う（**サーバーで必ず検証**）
- 自アプリのログイン状態は **自前セッション**（Cookie）で管理する
- Googleアカウントの一意キーは **`sub`**（= 変更されないユーザーID）  
  - emailは変わる/取得できない場合があるので **識別キーにしない**

---

## システム構成（最小）

1. フロント：Google Identity Services（ボタン）でログイン
2. フロント：取得した `id_token` をバックへ `POST /auth/google`
3. バック：`id_token` を検証（署名・iss・aud・exp）
4. バック：DBで `provider='google' AND provider_user_id=sub` を検索
5. バック：なければユーザー作成 → provider行作成
6. バック：HTTPOnly Cookie セッションを発行（`Set-Cookie`）

---

# 1. データテーブル作成SQL（PostgreSQL）

> スキーマは `login` を使用します。  
> **emailログイン** と **googleログイン** の両方を綺麗に扱える設計です。

## 1.1 login.users（ユーザー本体）

- Google初回ログイン時に username が未設定でも作れるように **NULL許容**
- 後でプロフィール画面で username を設定する運用がシンプル

```sql
CREATE TABLE login.users (
    user_id BIGSERIAL PRIMARY KEY,

    username VARCHAR(50),  -- allow NULL (set later)
    icon_url TEXT,

    total_tactile_length NUMERIC(10,3) DEFAULT 0,
    total_road_posts INTEGER DEFAULT 0,
    total_hearts INTEGER DEFAULT 0,

    is_active BOOLEAN DEFAULT TRUE,
    email_verified BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP
);
```

## 1.2 login.user_auth_providers（ログイン手段）

- 1レコード = 1つのログイン方法
- emailログインは `email + password_hash` 必須
- googleログインは `provider_user_id(sub)` 必須、`password_hash` は NULL
- ユニーク制約は **部分ユニークインデックス**で安全にする
  - emailログインの email は一意
  - googleログインの sub は一意
  - emailとgoogleで同じemailを持っても衝突しない

```sql
CCREATE TABLE login.user_auth_providers (
    auth_id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL
        REFERENCES login.users(user_id)
        ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL
        CHECK (provider IN ('email','google')),
    provider_user_id TEXT,   -- google: sub, email: NULL
    email VARCHAR(255),      -- email: required, google: optional
    password_hash TEXT,      -- email: required, google: NULL
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_uap_fields_by_provider CHECK (
      (provider='email'  AND email IS NOT NULL AND password_hash IS NOT NULL AND provider_user_id IS NULL)
      OR
      (provider='google' AND provider_user_id IS NOT NULL AND password_hash IS NULL)
    )
);

-- email login: email unique only among email providers
CREATE UNIQUE INDEX uix_uap_email_only
ON login.user_auth_providers (email)
WHERE provider = 'email';

-- google login: sub unique only among google providers
CREATE UNIQUE INDEX uix_uap_google_sub
ON login.user_auth_providers (provider_user_id)
WHERE provider = 'google';
```

## 1.3 login.email_verification_tokens（メール確認）

- シンプル運用なら「ユーザーにつき有効トークンは1個」でOK（再送時に上書き/削除）

```sql
CREATE TABLE login.email_verification_tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL
        REFERENCES login.users(user_id)
        ON DELETE CASCADE,

    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- keep only one active token per user (simple resend behavior)
CREATE UNIQUE INDEX uix_evt_one_per_user
ON login.email_verification_tokens (user_id);
```

---

# 2. フロントエンド変更内容（最小）

## 2.1 やること

- Google Identity Services（GIS）のスクリプトを読み込む
- 「Googleでログイン」ボタンを表示
- コールバックで `id_token` を受け取る
- バックエンドへ `POST /auth/google` で送る

## 2.2 最小HTML例

> `YOUR_CLIENT_ID.apps.googleusercontent.com` を置き換えてください。

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Login</title>
  <script src="https://accounts.google.com/gsi/client" async defer></script>
</head>
<body>
  <div id="g_id_onload"
       data-client_id="YOUR_CLIENT_ID.apps.googleusercontent.com"
       data-callback="onGoogleCredential">
  </div>

  <div class="g_id_signin" data-type="standard"></div>

  <script>
    async function onGoogleCredential(response) {
      const idToken = response.credential; // JWT

      const res = await fetch("/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id_token: idToken })
      });

      if (!res.ok) {
        alert("Login failed");
        return;
      }
      location.href = "/";
    }
  </script>
</body>
</html>
```

### 注意（最小の落とし穴回避）
- **フロント側でJWTをデコードして信用しない**（改ざんされる）
- ログイン成立は **バックエンドで検証してから**

---

# 3. バックエンド変更内容（Node.js / Express例）

## 3.1 追加する依存関係

- `google-auth-library`：IDトークン検証
- `cookie-parser`：Cookie扱い
- （任意）DBドライバ：`pg` など

```bash
npm i express cookie-parser google-auth-library
```

## 3.2 エンドポイント追加：POST /auth/google

以下の例は「検証 → DB検索/作成 → Cookie発行」の流れです。  
DB部分は疑似コードなので、あなたの環境の `pg` 等に置き換えてください。

```js
import express from "express";
import cookieParser from "cookie-parser";
import { OAuth2Client } from "google-auth-library";

const app = express();
app.use(express.json());
app.use(cookieParser());

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const client = new OAuth2Client(GOOGLE_CLIENT_ID);

// NOTE: Replace these DB functions with your actual implementation.
async function findProviderGoogleBySub(sub) { /* ... */ }
async function createUserAndGoogleProvider({ sub, email, name, picture }) { /* ... */ }
async function updateLastLoginAt(userId) { /* ... */ }
async function createSession(userId) { /* return sessionId */ }

app.post("/auth/google", async (req, res) => {
  try {
    const { id_token } = req.body;
    if (!id_token) return res.status(400).send("missing id_token");

    // 1) Verify ID token (signature, iss, aud, exp)
    const ticket = await client.verifyIdToken({
      idToken: id_token,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) return res.status(401).send("invalid token payload");

    const sub = payload.sub;                 // stable user id (primary)
    const email = payload.email ?? null;     // optional
    const name = payload.name ?? null;
    const picture = payload.picture ?? null;

    // 2) Find existing linked account
    let providerRow = await findProviderGoogleBySub(sub);

    // 3) Create if not found
    let userId;
    if (!providerRow) {
      const created = await createUserAndGoogleProvider({ sub, email, name, picture });
      userId = created.user_id;
    } else {
      userId = providerRow.user_id;
    }

    await updateLastLoginAt(userId);

    // 4) Issue your app session (HTTPOnly cookie)
    const sessionId = await createSession(userId);
    res.cookie("session", sessionId, {
      httpOnly: true,
      secure: true,        // set true on HTTPS
      sameSite: "lax",
      path: "/",
    });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(401).send("invalid token");
  }
});

app.listen(3000, () => console.log("http://localhost:3000"));
```

## 3.3 DB側の実装メモ（最小）

### Googleログイン（subで確定）
- 検索：`provider='google' AND provider_user_id = :sub`
- ない場合：
  - `login.users` をINSERT（usernameはNULLでOK）
  - `login.user_auth_providers` に google行をINSERT（provider_user_id=sub）

### Emailログイン（emailで確定）
- 検索：`provider='email' AND email = :email`
- `password_hash` を照合してログイン成立（bcrypt/argon2はアプリ側）

---

# 4. Google Cloudを使ったユーザ認証の方針と実装手順

ここで言う「Google Cloudにアプリ登録」とは、主に **OAuth 2.0 Client IDの発行**です。  
OIDCログインで「APIキー」は使いません（APIキーはGoogle API呼び出し向け）。

## 4.1 方針（初心者向け）

- **Google CloudでOAuthクライアントIDを作る**
- フロントはそのClient IDを使ってGoogleログインUIを表示
- バックエンドは `audience == Client ID` で検証して受け入れる
- 自アプリのログイン状態は **自前セッション**（HTTPOnly Cookie）

## 4.2 実装手順（具体）

### Step 1: OAuth同意画面（必要な場合だけ表示される）
Google Cloud Console:
- APIs & Services → OAuth consent screen
- App name / support email などを設定
- テスト段階は External + test users でも可（運用に合わせて）

※ここは「画面に言われたらやる」くらいでOK。

### Step 2: OAuth Client IDの作成（Web application）
Google Cloud Console:
- APIs & Services → Credentials
- Create Credentials → OAuth client ID
- Application type: Web application
- Authorized JavaScript origins:
  - 例：`https://your-domain.example`
  - ローカル検証なら `http://localhost:3000`
- 作成後に出る **Client ID** を控える

### Step 3: フロントへClient IDを設定
HTML内の `data-client_id` に貼る（例：`YOUR_CLIENT_ID.apps.googleusercontent.com`）

### Step 4: バックエンドへClient IDを設定
環境変数で管理（例）

```bash
export GOOGLE_CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com"
```

### Step 5: バックエンドでIDトークン検証を実装
- `verifyIdToken({ audience: GOOGLE_CLIENT_ID })` を必ず指定
- 検証できたら `payload.sub` をキーにDBを引く

### Step 6: セッション発行（HTTPOnly Cookie）
- Cookieに session id を載せる（DB/Redisにセッションを持つのが簡単）
- `Secure` はHTTPS時に true

---

# 5. 実装時のチェックリスト（最小）

- [ ] Googleログイン識別は **sub** を使っている
- [ ] バックエンドで `aud` が **自分のClient ID** と一致することを検証している
- [ ] Cookieは `HttpOnly`（JavaScriptから読めない）
- [ ] 本番はHTTPSで `Secure=true`
- [ ] DB制約が providerごとの必須項目を守れている（CHECK + 部分ユニーク）

---

# 6. 次に決めると良いこと（必要になったらでOK）

- アカウントリンク：
  - 既存emailユーザーとgoogleログインを同一userに紐づける機能
- ユーザー削除・退会：
  - `login.users` を消すと providerやtokenも `ON DELETE CASCADE` で消える
- token保存の強化：
  - email verification token をハッシュ保存にする（DB漏えい対策）

---
