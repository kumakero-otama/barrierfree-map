# 文書索引

最終整理日: 2026-08-18

## 現行仕様・提出時に参照する文書

- [`../README.md`](../README.md): 構成と入口
- [`../REPRODUCTION.md`](../REPRODUCTION.md): GCEからの再現手順
- [`../DEVELOPMENT.md`](../DEVELOPMENT.md): ローカル開発
- [`../TABLE_DDL.md`](../TABLE_DDL.md): PostgreSQLスキーマ概要
- [`stepby-current-spec-and-tasks.md`](stepby-current-spec-and-tasks.md): 現行仕様と残作業
- [`API_list.md`](API_list.md): API一覧
- [`../public/docs/openapi.yaml`](../public/docs/openapi.yaml): OpenAPI
- [`osm_change_api.md`](osm_change_api.md): OSM変更・取消し・監査・安全条件
- [`osm-community-consultation-draft.md`](osm-community-consultation-draft.md): コミュニティ説明内容
- [`cloud-incident-and-rollback-runbook.md`](cloud-incident-and-rollback-runbook.md): 障害対応と復元
- [`existing-data-migration-audit.md`](existing-data-migration-audit.md): 既存データ移行の別計画

## 現行機能の補足資料

- [`google_oidc_auth_guide_updated.md`](google_oidc_auth_guide_updated.md): Google OIDCの参考資料。実装値はソースと`.env.example`を優先
- [`osm_like_postgis_spec.md`](osm_like_postgis_spec.md): PostGIS設計の背景
- [`auth_login_stability_measures.md`](auth_login_stability_measures.md): 認証障害対策の経緯。PM2の記述は旧ローカル環境の履歴

## 履歴・旧構成資料

次の資料は設計経緯を残すため保管していますが、現在のGCE/UI10を再現する手順として使用しません。

- `Frontend_Migration_GitHub_Pages_Spec.md`
- `frontend_migration_beginner_guide.md`
- `guest_frontend_changes.md`
- `google_oidc_auth_guide.md`
- `loophole_to_tailscale_migration.md`
- `valhalla_4pref_setup.md`
- `table_sql.md`（初期PostgreSQL設計メモ。完全な現行定義は`../database/schema.sql`）
- `user_id_migration.sql`（過去の移行SQL）

現在の構成と矛盾した場合は、`README.md`、`REPRODUCTION.md`、`database/schema.sql`、OpenAPI、実装コードの順に確認してください。
