# StepBy PostgreSQLスキーマ

現在のUI0バックエンドはMariaDBではなく、PostgreSQL 16＋PostGISを使用します。

## 再現用SQL

完全なスキーマ定義は[`database/schema.sql`](../database/schema.sql)です。2026-08-18に稼働中の開発DBから、データ・所有者・権限を含めず`pg_dump --schema-only --no-owner --no-acl`で生成しました。

```bash
createdb --owner=stepby_dev stepby_app_dev
psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U stepby_dev \
  -d stepby_app_dev -f database/schema.sql
```

このSQLにはスキーマ、テーブル、シーケンス、制約、インデックス、追記型監査を保護するトリガーが含まれます。PostGIS拡張そのものは含めないため、管理者が先に次を実行してください。

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

## スキーマの役割

- `login`: StepByユーザー、Google認証、同意履歴、セッション、StepBy専用OSM OAuth
- `tactile`: GPS生点、フィット点、経路、タグ、Wayスナップショット
- `roadinfo`: 道情報、タグ、本人限定メモ、画像ファイルへの参照
- `osmchange`: OSM変更案、実行試行、record/changeset対応、追記監査、opt-out
- `experiment`: フィッティング比較、GPS再生、管理APIの実験記録
- `migration`: 旧システムから新DBへ移した記録の出典と、上書き禁止の移行履歴

## 主要テーブル

### `login`

- `users`
- `user_auth_providers`
- `user_sessions`
- `user_consents`
- `osm_service_account`
- `osm_service_oauth_states`
- `osm_service_account_audit`

`osm_connections`などの個人OSM連携用テーブルは移行監査のため残っていますが、現在のログイン・OSM送信には使用しません。

### `tactile`

- `sessions`
- `gps_raw`
- `gps_matched`
- `session_paths`
- `session_path_edges`
- `tags`
- `session_tags`
- `way_snapshots`

### `roadinfo`

- `road_info_point`
- `road_info_tag`
- `road_info_point_tag`
- `road_info_note`
- `road_info_media`
- `submission_keys`

画像本体はPostgreSQLではなく`uploads/`へ保存し、DBには参照URLと所有者等を保存します。

### `osmchange`

- `change_plans`
- `execution_attempts`
- `record_links`
- `audit_events`
- `opt_out_rules`

監査履歴は削除・上書きせず、新しいイベントとして追記します。

### `migration`

- `legacy_record_sources`: 旧記録のハッシュ、新DB内の記録ID、旧ユーザー名、安全に一意照合できた新ユーザーID
- `legacy_record_events`: 取込み件数や対応ユーザーを残す追記型履歴

旧328記録は旧DBを参照し続けるのではなく、`tactile.sessions`、`tactile.gps_raw`、`tactile.session_paths`へ新規記録と同じ形で複製済みです。旧DBへは書き込まず、同じハッシュを二度取り込まない制約を設けています。

## スキーマ更新

既存DBへ変更を加える場合は`migrations/`へPostgreSQL用SQLを追加します。新規環境には常に[`../database/schema.sql`](../database/schema.sql)を使用してください。旧MariaDB用SQLは現行ツリーから削除しており、必要な場合だけGit履歴を参照します。

個人情報や実記録を含むDBダンプはGitへ追加しないでください。
