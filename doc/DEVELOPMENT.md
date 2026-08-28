# StepByバックエンド開発ガイド

この文書はUI11用バックエンドのローカル開発手順です。旧Mapbox・PM2・MariaDB構成は対象外です。クラウドを一から再現する場合は[`REPRODUCTION.md`](REPRODUCTION.md)を使用してください。

## 必要なソフトウェア

- Node.js 18以上
- npm（`npm ci`が使えること）
- PostgreSQL 16
- PostGIS 3
- Git

CaddyとsystemdはGCE相当の公開環境で必要ですが、localhost開発には不要です。

## 1. 依存関係

```bash
npm ci
```

依存バージョンは`package-lock.json`を正とします。

## 2. 開発DB

本番DBへ接続せず、空の専用DBを作成します。

```bash
sudo -u postgres createuser --pwprompt stepby_dev
sudo -u postgres createdb --owner=stepby_dev stepby_app_dev
psql -U stepby_dev -d stepby_app_dev -f database/schema.sql
```

`config.dev.example.yaml`をコピーし、作成したDBだけを指定します。

```bash
cp config.dev.example.yaml config.dev.yaml
```

## 3. 環境変数

`.env.example`を参考に、シェルまたは利用中のサービス管理機能へ設定します。`.env`はアプリが自動では読み込みません。

ローカル開発で最低限必要なのは次です。

```bash
export NODE_ENV=development
export HTTP_HOST=127.0.0.1
export HTTP_PORT=3100
export DB_CONFIG_PATH="$PWD/config.dev.yaml"
export EXPERIMENT_DB_CONFIG_PATH="$PWD/config.dev.yaml"
export GOOGLE_CLIENT_ID="YOUR_GOOGLE_WEB_CLIENT_ID"
export ACCESS_TOKEN_SECRET="32文字以上のランダム値"
export DEV_ADMIN_KEY="開発管理画面用の十分に長いランダム値"
export CORS_ALLOWED_ORIGINS="http://localhost:8080"
export OSM_WRITES_ENABLED=false
```

Googleログインを試さないAPI単体確認では`GOOGLE_CLIENT_ID`を空にできますが、認証APIは利用できません。

## 4. 起動

```bash
npm start
```

確認例:

```bash
curl -i http://127.0.0.1:3100/api/config
```

認証必須APIが`401`を返すことは正常です。サーバーログは`logs/`へ書かれます。

## 5. フロントエンドとの接続

UI10は別リポジトリ`StepBy`にあります。GitHub Pages以外のローカルOriginを使う場合は、`CORS_ALLOWED_ORIGINS`へ明示的に追加します。

マップマッチングはUI10のブラウザ内JavaScriptで実行されます。`/api/match`、`/api/trace`、Mapbox、Valhalla関連コードは旧版・比較診断との互換用であり、UI10の通常記録フローでは使いません。

## 6. OSM開発時の原則

- 初期値は必ず`OSM_WRITES_ENABLED=false`
- 変更案生成とモック試験を先に行う
- 本番OSMへの架空データ送信は禁止
- 利用者の保存・本人所有記録の削除以外は、操作ごとの管理者許可が必要
- 送信前に追記監査、所有者、冪等性、最新Versionを確認
- 非公開PROタグとひとことメモをOSM payloadへ含めない

詳細は[`osm_change_api.md`](osm_change_api.md)を参照してください。

## 7. テスト

```bash
for file in test/*.test.js; do node "$file"; done
```

結合テストは専用DBとテスト設定が必要です。`config.security.dev.json`などの秘密設定はGit管理しません。

## 8. 変更時に更新する文書

構成、認証、DB、公開経路、主要APIを変更した場合は、同じ変更で次も更新します。

- `README.md`
- `REPRODUCTION.md`
- `TABLE_DDL.md`と必要に応じて`database/schema.sql`
- `API_list.md`と`public/docs/openapi.yaml`
- `stepby-current-spec-and-tasks.md`
- `system-architecture.svg`と`project-plan-preview.html`
