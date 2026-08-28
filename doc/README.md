# 文書索引

最終整理日: 2026-08-29

## 現行仕様・提出時に参照する文書

- [`../README.md`](../README.md): 構成と入口
- [`REPRODUCTION.md`](REPRODUCTION.md): GCEからの再現手順
- [`DEVELOPMENT.md`](DEVELOPMENT.md): ローカル開発
- [`TABLE_DDL.md`](TABLE_DDL.md): PostgreSQLスキーマ概要
- [`stepby-current-spec-and-tasks.md`](stepby-current-spec-and-tasks.md): 現行仕様と残作業
- [`API_list.md`](API_list.md): API一覧
- [`../public/docs/openapi.yaml`](../public/docs/openapi.yaml): OpenAPI
- [`osm_change_api.md`](osm_change_api.md): OSM変更・取消し・監査・安全条件
- [`osm-community-consultation-draft.md`](osm-community-consultation-draft.md): コミュニティ説明内容
- [`cloud-incident-and-rollback-runbook.md`](cloud-incident-and-rollback-runbook.md): 障害対応と復元
- [`existing-data-migration-audit.md`](existing-data-migration-audit.md): 既存データ移行の別計画

## 現行機能の補足資料

- [`google_oidc_auth_guide.md`](google_oidc_auth_guide.md): Google OIDCの参考資料。実装値はソースと`.env.example`を優先
- [`osm_like_postgis_spec.md`](osm_like_postgis_spec.md): PostGIS設計の背景
- [`osm-review-workflow.md`](osm-review-workflow.md): 管理者によるOSM公開確認の流れ

## 整理方針

このディレクトリには現行GCE・PostgreSQL・UI11構成の理解、再現、運用に必要な資料だけを置きます。MariaDB、PM2、Loophole、旧Tailscale、旧Valhalla構築、UI10移行途中の資料はGit履歴で参照できるため、現行ツリーから削除しています。

現在の構成と矛盾した場合は、リポジトリ直下の`README.md`、`REPRODUCTION.md`、`../database/schema.sql`、OpenAPI、実装コードの順に確認してください。
