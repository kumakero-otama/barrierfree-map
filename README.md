# StepBy backend (`barrierfree-map`)

StepBy UI11のバックエンド実装です。現在の開発・クラウド版は、このリポジトリの`dev`ブランチを基準にしています。

## 現在の構成

- フロントエンド: GitHub Pages上の別リポジトリ[`StepBy`](https://github.com/kumakero-otama/StepBy)
- API: Google Compute Engine上のNode.js 18
- HTTPS: Caddyから`127.0.0.1:3100`のNode.jsへリバースプロキシ
- DB: 同じGCE VM上のPostgreSQL 16＋PostGIS
- 認証: Google OpenID Connect。一般利用者に個人OSMアカウントは要求しない
- OSM編集: サーバーで暗号化保存したStepBy専用OSMアカウントを使用
- 機密情報: Google Secret ManagerからVM起動時に取得
- バックアップ: PostgreSQLのcustom dumpと`uploads/`をCloud Storageへ日次保存し、30日で削除

ブラウザフィッティングはフロントエンド内のJavaScriptで実行します。このバックエンドは認証、記録保存、OSM道路網取得、OSM変更案、送信・取消し、追記監査を担当します。

## 再現に必要な情報

第三者が新しい環境を構築する場合は、最初に[`REPRODUCTION.md`](REPRODUCTION.md)を参照してください。

- Node.js依存関係: [`package.json`](package.json)、[`package-lock.json`](package-lock.json)
- PostgreSQLスキーマ: [`database/schema.sql`](database/schema.sql)
- DB概要: [`TABLE_DDL.md`](TABLE_DDL.md)
- ローカル開発: [`DEVELOPMENT.md`](DEVELOPMENT.md)
- GCE/Caddy/systemd/バックアップ: [`cloud/`](cloud/)
- 設定例: [`.env.example`](.env.example)、[`config.dev.example.yaml`](config.dev.example.yaml)
- API一覧: [`documents/API_list.md`](documents/API_list.md)、[`public/docs/openapi.yaml`](public/docs/openapi.yaml)
- OSM処理と安全条件: [`documents/osm_change_api.md`](documents/osm_change_api.md)
- 現行仕様: [`documents/stepby-current-spec-and-tasks.md`](documents/stepby-current-spec-and-tasks.md)
- 文書索引: [`documents/README.md`](documents/README.md)

## Node.jsライブラリ

直接依存は次の4つです。間接依存を含む固定バージョンは`package-lock.json`に記録されています。

- `google-auth-library`: Google IDトークン検証
- `nodemailer`: 管理者への公開確認メール送信
- `pg`: PostgreSQL接続
- `yaml`: DB設定ファイル読込み

```bash
npm ci
```

## 最小起動

OSM書込みを無効にしたローカル環境の例です。

```bash
cp config.dev.example.yaml config.dev.yaml
cp .env.example .env
npm ci
DB_CONFIG_PATH="$PWD/config.dev.yaml" \
HTTP_HOST=127.0.0.1 \
HTTP_PORT=3100 \
OSM_WRITES_ENABLED=false \
npm start
```

`.env`はNode.jsが自動読込みするファイルではありません。ローカルではシェルやサービス管理機能から環境変数として読み込ませてください。クラウドでは`cloud/fetch-runtime-secret.sh`がSecret Managerの内容を`/run/stepby/runtime.env`へ展開し、systemdが読み込みます。

## セキュリティ

- パスワード、OAuthクライアントシークレット、アクセストークン、暗号鍵はGitへ保存しません。
- 再現環境では`OSM_WRITES_ENABLED=false`を初期値にしてください。
- OSM送信を有効にするには、専用OSMアカウント、追記監査、所有者確認、冪等性、最新Version確認、公開仕様、コミュニティ手続が必要です。
- 旧個人OSM OAuth APIは`410 individual_osm_oauth_retired`を返し、現在の送信には使いません。

## テスト

OSMへ接続しない単体テストは次のように実行できます。

```bash
npm test
```

`*.integration.js`は専用テストDBとローカル秘密設定を必要とします。本番DBや本番OSMをテスト先にしないでください。
