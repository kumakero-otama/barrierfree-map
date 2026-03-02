# フロントを GitHub Pages へ移行する際の仕様変更まとめ（＋PWA分離デザイン構成）

対象：バリアフリー地図アプリ\
移行方針：フロントのみ GitHub Pages
に移動し、API（認証含む）はローカルサーバ＋loophole 経由で継続利用する\
認証方針：Cookie を使わず、Google 認証（ID トークン）→ アプリ用 Access
Token（Bearer）で認可する

------------------------------------------------------------------------

## 0. 現状と移行後の構成

### 0.1 現状（ローカル運用）

-   フロント：ローカルで配信（同一オリジンまたは同一ドメインで動作）
-   バックエンドAPI：ローカル
-   認証：Googleログイン + サーバセッションCookie
    等（Cookieでログイン維持）

### 0.2 移行後（想定）

-   フロント：GitHub Pages（例：`https://<user>.github.io/<repo>/`）
-   バックエンドAPI：ローカルサーバを `https://<xxx>.loophole.site`
    で公開
-   認証：Cookie無し
    -   フロントが Google ID Token を取得
    -   ID Token を API へ送って検証
    -   API がアプリ用 Access Token（JWT等）を返却
    -   フロントは `Authorization: Bearer <token>` で API 呼び出し

------------------------------------------------------------------------

## 1. 仕様変更の全体一覧（やることチェック）

### 1.1 フロント側（GitHub Pages対応）

-   [ ] `API_BASE_URL` を「ローカル」から「loophole の HTTPS
    URL」に切り替え可能にする（設定 or 環境変数）
-   [ ] API呼び出しで Cookie 依存を廃止（`credentials: "include"`
    を使わない）
-   [ ] 認証ヘッダ `Authorization: Bearer <access_token>` を付けて API
    を呼ぶ
-   [ ] Googleログインの実装を「ID Token 取得」前提にする（GIS: Google
    Identity Services 等）
-   [ ] リロード時のログイン継続：Token の再取得戦略を決める（メモリ保持
    / 永続化 / サイレント再取得）
-   [ ] GitHub
    Pages配下のパス（`/<repo>/`）に対応（ルーティングや相対パス）

### 1.2 バックエンド側（CORS＋Bearer認証）

-   [ ] CORS を GitHub Pages の Origin に対して許可
-   [ ] `Authorization` ヘッダを許可（preflight含む）
-   [ ] Google ID Token の検証処理を追加（`aud` / `iss` / `exp` /
    `sub`）
-   [ ] アプリ用 Access
    Token（JWT等）発行エンドポイントを追加（例：`POST /auth/google`）
-   [ ] 全 API で `Authorization: Bearer` を検証するミドルウェアを追加
-   [ ] Cookie発行/セッション依存の認証処理を撤去 or
    無効化（移行期間は併用でも可）

### 1.3 Google側（OAuth設定）

-   [ ] Authorized JavaScript origins に GitHub Pages を追加
-   [ ] Authorized redirect URI（使う方式に応じて）を追加
-   [ ] Client ID の公開範囲と取り扱いを確認（フロントに置く前提）

------------------------------------------------------------------------

## 2. GitHub Pages 設定（フロント公開）

### 2.1 公開方法の選択

-   ビルド無し（Vanilla HTML/JS/CSS をそのまま配信）
-   ビルド有り（TypeScript/Vite等 → `dist/` を生成して配信）

#### A) ビルド無し

-   リポジトリのルート、または `docs/` をそのまま Pages で公開
-   SPA ルーティングの場合は 404 対策が必要な場合あり（後述）

#### B) ビルド有り（推奨：Actions で自動ビルド → Pages 配信）

-   `npm ci` → `npm run build` → `dist/` を GitHub Pages にデプロイ

### 2.2 Pages の基本設定（概要）

-   GitHub リポジトリ Settings → Pages
-   Source を GitHub Actions に設定（推奨）
-   公開URLは `https://<user>.github.io/<repo>/`

### 2.3 リポジトリ内パスに注意（重要）

GitHub Pages は多くの場合 `/<repo>/` 配下になる。

例：`https://user.github.io/barrierfree-map-frontend/`

-   画像/JS/CSS のパスを **相対パス** または basePath 対応にする
-   SPA ルーティングの場合、リロードで 404 になる場合がある
    -   対策：`404.html` を `index.html`
        に寄せる等（SPA向けの一般的手法）

------------------------------------------------------------------------

## 3. Cookie無し認証（Google ID Token → アプリトークン）

### 3.1 認証フロー（推奨）

1.  フロントが Google ログインで **ID Token**（JWT）を取得
2.  フロントが API に `POST /auth/google` 等で ID Token を送る
3.  API が ID Token を検証
4.  API がアプリ用 `access_token`（JWTなど）を返す
5.  フロントは以後 `Authorization: Bearer <access_token>` で API
    アクセス

### 3.2 フロント側：API呼び出し仕様変更

-   変更前：Cookieで認証（例：セッションCookie）
-   変更後：Bearerで認証

#### 擬似コード（例）

-   Access Token を保持（推奨：まずはメモリ。必要なら永続化）
-   API 呼び出し時に必ず `Authorization` ヘッダを付与

------------------------------------------------------------------------

## 4. 追加設計：複数PWAデザイン検証構成（安全分離版）

### 4.1 目的

本命UIと複数のデザイン候補を、互いに干渉しない「完全分離PWA」として検証可能にする。

### 4.2 推奨ディレクトリ構成

（ルートに Service Worker を置かず、各フォルダを独立PWAにする）

    /
      index.html              ← デザイン一覧 or 本命へのリダイレクト（SWは置かない）

      prod/                   ← 本命UI（独立PWA）
        index.html
        manifest.webmanifest
        sw.js
        assets/...

      design-a/               ← 候補A（独立PWA）
        index.html
        manifest.webmanifest
        sw.js
        assets/...

      design-b/               ← 候補B（独立PWA）
        index.html
        manifest.webmanifest
        sw.js
        assets/...

      design-c/               ← 候補C（独立PWA）
        index.html
        manifest.webmanifest
        sw.js
        assets/...

### 4.3 設計原則

1.  ルート（/）には Service Worker を置かない（全体支配を防ぐ）
2.  各デザインは必ず自分のフォルダ内に `sw.js` を配置する
3.  `manifest.webmanifest` の `scope` と `start_url` は `./` に設定する
4.  `name` / `short_name`
    はデザインごとに変更する（端末インストール時の識別用）
5.  GitHub Pages 環境では相対パス（`./`）を徹底する

### 4.4 Service Worker 登録例（各デザインの index.html）

``` html
<link rel="manifest" href="./manifest.webmanifest">

<script>
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" });
}
</script>
```

### 4.5 manifest 例

``` json
{
  "name": "BarrierFreeMap（Design A）",
  "short_name": "BFM A",
  "start_url": "./",
  "scope": "./",
  "display": "standalone"
}
```

### 4.6 注意事項（重要）

-   ルートに `sw.js` を置くと `design-*`
    を巻き込む可能性がある（リンク有無は関係ない）
-   Service Worker の支配範囲は「URL階層（scope）」で決まる
-   キャッシュ名（Cache Storage
    のキー）もデザインごとに分けるのが望ましい

------------------------------------------------------------------------

## 5. 公開URL例

    https://<user>.github.io/<repo>/prod/
    https://<user>.github.io/<repo>/design-a/
    https://<user>.github.io/<repo>/design-b/

------------------------------------------------------------------------

## 6. まとめ

-   フロントは GitHub Pages、API は loophole で継続
-   認証は Cookie を捨てて「Google ID Token → アプリ用 Access
    Token（Bearer）」に移行
-   PWA のデザイン検証は「prod/ と design-\*/
    をフォルダ分離」するのが最も安全
-   ルートに Service Worker を置かない（干渉を防ぐ）

------------------------------------------------------------------------

## 7. OpenAPI（Swagger）による API 仕様の明文化（推奨）

フロント（GitHub Pages）とバックエンド（loophole
経由）が完全に別オリジンになるため、
「APIの入力/出力/認証/エラー形式」をコードと別に明文化しておくと、開発・運用が安定する。

ここでは **OpenAPI（Swagger）** を使って API 仕様を管理し、Swagger UI
で可視化する導入方法をまとめる。

### 7.1 用語（ざっくり）

-   **OpenAPI**：API仕様を YAML/JSON
    で書くための標準フォーマット（契約書）
-   **Swagger UI**：OpenAPI を読み込んで、ブラウザで API
    ドキュメント＆試し打ちができる画面（いわゆる「Swagger画面」）
-   **Swagger Editor**：OpenAPI
    を編集してその場でプレビューできるエディタ（ローカル/オンライン）

> 「swag 何とか」＝だいたい Swagger UI のこと、と思ってOK。

### 7.2 何が嬉しいか（分離構成で効くポイント）

-   フロントとバックエンドの"認識ズレ"を減らせる（パラメータ名、レスポンス形式、エラー形式）
-   Bearer 認証（JWT 等）の必須化を仕様として固定できる
-   CORS の前提や 401/403 の意味をチーム内で統一できる
-   将来、API を増やしてもドキュメントが腐りにくい

### 7.3 最小導入の方針（おすすめ）

-   `openapi.yaml`（または `openapi.json`）を
    **バックエンドのリポジトリ** に置く
-   バックエンドで **Swagger UI を `/docs`** などで配信する
-   フロントは「このURLが仕様の正」として参照する（実装の拠り所）

### 7.4 OpenAPI に入れるべき項目（このプロジェクトの最小セット）

-   `POST /auth/google`（ID Token → アプリ用 access_token）
    -   リクエスト：`id_token`
    -   レスポンス：`access_token`（JWT等）, `expires_in` 等
-   すべての保護APIに対する **Bearer
    認証**（`Authorization: Bearer <token>`）
-   代表的なエラー形式（例：`{ "error": { "code": "...", "message": "..." } }`）
-   401 / 403 の返し分けルール
-   CORS の前提（少なくとも Origin の想定）

### 7.5 OpenAPI（Swagger UI）の導入手順（概念）

バックエンド言語/フレームワークによって具体的手段は違うが、流れは共通：

1.  **openapi.yaml
    を用意**（最初は手書きでOK。後で自動生成に寄せてもよい）
2.  **Swagger UI をホスト**（バックエンド側で `/docs`
    を用意するか、静的に配信する）
3.  **開発ルール化**
    -   APIを変えるときは openapi.yaml も同時に更新
    -   フロントは openapi.yaml を正として実装

### 7.6 運用おすすめ（現実的にラクなやつ）

-   まずは「手書き OpenAPI」→ 仕様が固まったら自動生成/型共有を検討
-   破壊的変更は `v1` / `v2` のようにバージョンを切る（URL or
    `info.version`）
-   Swagger UI
    は本番で公開したくない場合、IP制限/Basic認証/管理者のみなどで保護する

### 7.7 追加でやると強い（任意）

-   フロント側で OpenAPI から API クライアントを自動生成（型のズレ防止）
-   CIで openapi.yaml の妥当性チェック（lint）を回す
-   PRで Swagger UI の差分をレビューできるようにする

------------------------------------------------------------------------

### 付録：OpenAPI の最小テンプレ（雛形）

以下は「Bearer 認証」と「/auth/google」を含む
**最小の枠組み**（実APIに合わせて要調整）。

``` yaml
openapi: 3.0.3
info:
  title: BarrierFreeMap API
  version: 1.0.0
servers:
  - url: https://<xxx>.loophole.site
paths:
  /auth/google:
    post:
      summary: Google ID Token を検証してアプリ用トークンを発行
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [id_token]
              properties:
                id_token:
                  type: string
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
                required: [access_token]
                properties:
                  access_token:
                    type: string
                  expires_in:
                    type: integer
        "401":
          description: Unauthorized
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
security:
  - bearerAuth: []
```

※このテンプレは「雛形」なので、実際は保護しないエンドポイント（例：`/auth/google`）を
`security: []` で外すなど調整する。
