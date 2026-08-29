# StepByバックエンド再現手順

最終確認日: 2026-08-29

この文書は、`barrierfree-map`の`main`ブランチから、正式UI0用バックエンドを新しい環境へ再構築するための手順です。実在ユーザーのデータや本番OSMへの書込みは、再現条件に含めません。新規環境ではOSM書込みを無効にして開始します。

## 1. 対象ソース

```bash
git clone --branch main https://github.com/kumakero-otama/barrierfree-map.git
cd barrierfree-map
git rev-parse HEAD
```

再現結果には使用したcommit IDを記録してください。追加開発を行う場合は`dev`ブランチを使い、確認済み変更だけを`main`へ昇格します。

フロントエンドは別リポジトリ[`StepBy`](https://github.com/kumakero-otama/StepBy)のUI0です。

## 2. 確認済み動作環境

- Google Compute Engine `e2-micro`
- Ubuntu 24.04 LTS
- Node.js 18.19.1
- npm
- PostgreSQL 16.14
- PostGIS
- Caddy 2.6系
- systemd
- Google Secret Manager
- Google Cloud Storage

Node.jsの直接依存:

- `google-auth-library` 10系
- `nodemailer` 9系
- `pg` 8系
- `yaml` 2系

固定された完全な依存ツリーは`package-lock.json`を参照し、`npm ci`で導入します。

## 3. GCEとIAM

新しいGCPプロジェクトまたは既存プロジェクトに、Ubuntu 24.04 LTSのVMを作ります。外部からはHTTP/HTTPSだけを許可し、Node.jsの3100番ポートを直接公開しません。

VMのサービスアカウントには、目的に応じて最小限の権限を付与します。

- Secret Managerの指定secretを読み取る権限
- 指定Cloud Storage bucketへバックアップオブジェクトを作成する権限
- 復元も行う場合だけ、そのbucketのオブジェクトを読み取る権限

サービスアカウント鍵JSONは作成せず、GCEメタデータ認証を使用します。

## 4. OSパッケージ

```bash
sudo apt update
sudo apt install -y nodejs npm postgresql postgresql-contrib postgis \
  postgresql-16-postgis-3 caddy curl ca-certificates git
```

ディストリビューションのNode.jsが18未満の場合は、信頼できる公式配布手段でNode.js 18を導入してください。

## 5. アプリ用ユーザーと配置

```bash
sudo useradd --system --home /srv/stepby --shell /usr/sbin/nologin stepby
sudo install -d -o stepby -g stepby -m 0750 /srv/stepby/releases
sudo install -d -o stepby -g stepby -m 0750 /srv/stepby/releases/barrierfree-map
sudo install -d -o stepby -g stepby -m 0750 /srv/stepby/releases/barrierfree-map/logs
sudo install -d -o stepby -g stepby -m 0750 /srv/stepby/releases/barrierfree-map/data
sudo install -d -o stepby -g stepby -m 0750 /srv/stepby/releases/barrierfree-map/uploads
sudo ln -s /srv/stepby/releases/barrierfree-map /srv/stepby/current
```

cloneした内容を`/srv/stepby/releases/barrierfree-map`へ配置し、次を実行します。

```bash
cd /srv/stepby/current
sudo -u stepby npm ci --omit=dev
```

## 6. Secret Manager

Secret Managerには、シェルが読み込める`KEY='value'`形式のテキストを1つのsecret versionとして保存します。必要な名前は`.env.example`を参照してください。

最低限必要な秘密設定:

- `STEPBY_DB_PASSWORD`
- `GOOGLE_CLIENT_ID`
- `ACCESS_TOKEN_SECRET`（32文字以上のランダム値）
- `DEV_ADMIN_KEY`
- `OSM_TOKEN_ENCRYPTION_KEY`
- `OSM_OAUTH_CLIENT_ID`、`OSM_OAUTH_CLIENT_SECRET`（専用OSM OAuthを設定する場合）

動作制御設定:

- `OSM_WRITES_ENABLED=false`
- `OSM_COMMUNITY_APPROVED=false`
- `OSM_API_BASE_URL=https://api.openstreetmap.org`
- `OVERPASS_HOST`
- `CORS_ALLOWED_ORIGINS`

再現開始時に`OSM_WRITES_ENABLED=true`へ変更しないでください。OSMのメールアドレス・パスワードはSecret Managerにもアプリにも保存せず、OAuthアクセストークンだけをアプリ管理画面経由で暗号化保存します。

`cloud/fetch-runtime-secret.sh`内の既定GCP project IDとsecret IDは、再現先に合わせて`STEPBY_GCP_PROJECT_ID`、`STEPBY_RUNTIME_SECRET_ID`で上書きします。systemdから使用する場合は、`stepby-dev.service`と`stepby-db-backup.service`のdrop-inへこの2変数を設定してください。

API用unitの設定例:

```ini
# sudo systemctl edit stepby-dev.service
[Service]
Environment=STEPBY_GCP_PROJECT_ID=YOUR_GCP_PROJECT_ID
Environment=STEPBY_RUNTIME_SECRET_ID=YOUR_SECRET_ID
```

## 7. Secret取得スクリプト

```bash
sudo install -o root -g root -m 0755 cloud/fetch-runtime-secret.sh \
  /usr/local/sbin/stepby-fetch-runtime-secret
sudo STEPBY_GCP_PROJECT_ID=YOUR_GCP_PROJECT_ID \
  STEPBY_RUNTIME_SECRET_ID=YOUR_SECRET_ID \
  /usr/local/sbin/stepby-fetch-runtime-secret
sudo test -r /run/stepby/runtime.env
```

`/run/stepby/runtime.env`は`root:stepby`、`0640`で作成されます。内容をログや提出資料へ出力しないでください。

## 8. PostgreSQLとPostGIS

```bash
sudo install -o root -g root -m 0755 cloud/configure-cloud-db.sh \
  /usr/local/sbin/stepby-configure-cloud-db
sudo /usr/local/sbin/stepby-configure-cloud-db
sudo -u postgres psql -d stepby_app_dev -c 'CREATE EXTENSION IF NOT EXISTS postgis;'
sudo -u stepby sh -c 'set -a
. /run/stepby/runtime.env
set +a
PGPASSWORD="$STEPBY_DB_PASSWORD" psql -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -U stepby_dev -d stepby_app_dev \
  -f /srv/stepby/current/database/schema.sql'
```

`cloud/configure-cloud-db.sh`は`stepby_dev`ロール、`stepby_app_dev`データベース、`/etc/stepby/config.dev.yaml`を作成します。

スキーマだけを確認する例:

```bash
sudo -u postgres psql -d stepby_app_dev -c '\dn'
sudo -u postgres psql -d stepby_app_dev -c '\dt login.*'
sudo -u postgres psql -d stepby_app_dev -c '\dt tactile.*'
sudo -u postgres psql -d stepby_app_dev -c '\dt osmchange.*'
```

## 9. systemdでAPIを起動

`cloud/stepby-dev.service`の次の値を再現先へ合わせて確認します。

- `WorkingDirectory`
- `CORS_ALLOWED_ORIGINS`
- `DB_CONFIG_PATH`
- `HTTP_PORT=3100`

VM再起動で`/run`が空になっても動くよう、unitは`ExecStartPre`でSecret Managerから設定を取得し、`ExecStart`のシェル内でそのファイルを読み込んでからNode.jsを起動します。`EnvironmentFile`へ戻す場合は、systemdが`ExecStartPre`より先にEnvironmentFileを評価する点に注意してください。

```bash
sudo install -o root -g root -m 0644 cloud/stepby-dev.service \
  /etc/systemd/system/stepby-dev.service
sudo systemctl daemon-reload
sudo systemctl enable --now stepby-dev
sudo systemctl status stepby-dev --no-pager
```

## 10. Caddy

`cloud/Caddyfile`のホスト名を再現先のDNS名へ変更し、80/443番がVMへ到達するよう設定します。

```bash
sudo install -o root -g root -m 0644 cloud/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

CaddyがHTTPSを終端し、Node.jsの`127.0.0.1:3100`へ転送します。

## 11. Cloud Storageバックアップ

非公開bucketを作り、`cloud/storage-lifecycle.json`の30日削除ルールを適用します。bucket名は`STEPBY_BACKUP_BUCKET`で指定します。

```bash
sudo install -o root -g root -m 0755 cloud/backup-development-db.sh \
  /usr/local/sbin/stepby-backup-development-db
sudo install -o root -g root -m 0644 cloud/stepby-db-backup.service \
  /etc/systemd/system/stepby-db-backup.service
sudo install -o root -g root -m 0644 cloud/stepby-db-backup.timer \
  /etc/systemd/system/stepby-db-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now stepby-db-backup.timer
```

バックアップ対象:

- PostgreSQL `stepby_app_dev`のcustom-format dump
- `/srv/stepby/current/uploads`のtar.gz

## 12. 監視

```bash
sudo install -o root -g root -m 0755 cloud/observe-health.sh \
  /usr/local/sbin/stepby-observe-health
sudo install -o root -g root -m 0644 cloud/stepby-health-observation.service \
  /etc/systemd/system/stepby-health-observation.service
sudo install -o root -g root -m 0644 cloud/stepby-health-observation.timer \
  /etc/systemd/system/stepby-health-observation.timer
sudo systemctl daemon-reload
sudo systemctl enable --now stepby-health-observation.timer
```

再現先のホスト名やDB名を変更した場合は、`cloud/observe-health.sh`も合わせて変更します。

## 13. OSM専用アカウント

OSM送信を使わない再現試験では、この作業は不要です。

運用環境では、管理画面からStepBy専用OSMアカウントのOAuth 2.0＋PKCE認証を行います。一般利用者の個人OSMアカウントは使用しません。書込みを有効化する前に[`osm_change_api.md`](osm_change_api.md)の安全条件とコミュニティ手続をすべて満たしてください。

## 14. 動作確認

```bash
systemctl is-active stepby-dev postgresql caddy
curl -i https://YOUR_API_HOST/api/config
curl -i https://YOUR_API_HOST/auth/me
```

- `/api/config`が正常応答する
- 未認証の`/auth/me`が`401`を返す
- Node.jsが3100番で外部へ直接公開されていない
- DB接続エラーがない
- `OSM_WRITES_ENABLED=false`である
- バックアップの手動実行後に、指定bucketへdumpとuploads archiveが作成される

単体テスト:

```bash
for file in test/*.test.js; do node "$file"; done
```

## 15. 提出物に含めないもの

- Secret Managerの実値
- DBパスワード
- Google/OSM OAuthクライアントシークレット
- OSMアクセストークン
- 管理者キー、署名鍵、暗号鍵
- 実ユーザー、GPS、メモ、画像を含むDB dump
- `uploads/`の実ファイル

提出時はこの文書、ソース、`package-lock.json`、`database/schema.sql`、設定例、cloud設定を含めれば、秘密値と実データを除く動作環境を再現できます。
