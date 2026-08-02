
### OSM変更案API（開発版・送信ロック中）

このAPI群は変更案と監査履歴だけを扱う。現段階ではOSMへの通信コードを持たず、実行系APIは常に `423 osm_write_locked` を返す。

- `GET /api/osm/status`: 安全装置の状態を取得する。
- `POST /api/osm/plans`: `merge`、`delete`、`revert` の変更案を追記保存する。
- `GET /api/osm/plans/:planId`: 変更案と監査イベントを取得する。作成者または管理者のみ。
- `POST /api/osm/plans/:planId/revert-plan`: before/afterと操作順を反転した巻き戻し案を新規作成する。OSMへは送信しない。
- `POST /api/osm/plans/:planId/approve`: 現在は必ず `423`。
- `POST /api/osm/plans/:planId/execute`: 現在は必ず `423`。
- `POST /api/osm/plans/:planId/delete-elements`: 現在は必ず `423`。
- `POST /api/osm/plans/:planId/execute-revert`: 現在は必ず `423`。
- `GET /api/osm/audit-events`: 管理者キーが必要な追記型監査履歴一覧。

変更案の各要素には `elementType` (`node|way|relation`)、`action` (`create|modify|delete`)、既存要素なら `osmId` と `version`、復元に必要な `before` と `after` を保存する。変更案と監査イベントにはUPDATE・DELETEを拒否するDBトリガーが設定される。
