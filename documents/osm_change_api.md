
### OSM変更API（開発版・送信ロック中）

変更案、送信、取消送信、監査履歴を扱う。送信コードは実装済みだが、開発サーバーでは `OSM_WRITES_ENABLED` を有効にしていないため、実行系APIはネットワーク処理へ入る前に `423 osm_write_locked` を返す。

- `GET /api/osm/status`: 安全装置の状態を取得する。
- `POST /api/osm/plans`: `merge`、`delete`、`revert` の変更案を追記保存する。
- `POST /api/osm/split-plan`: Way途中の開始・終了位置から、Node作成、Way分割、`tactile_paving=yes` の変更案を作る。
- `GET /api/osm/plans/:planId`: 変更案と監査イベントを取得する。作成者または管理者のみ。
- `POST /api/osm/plans/:planId/revert-plan`: 送信結果のOSM ID・Versionを使い、反対変更を新規作成する。元プランが未送信なら、実行不能の確認用テンプレートだけを作る。
- `POST /api/osm/plans/:planId/approve`: 現在は必ず `423`。
- `POST /api/osm/plans/:planId/execute`: changesetを作成し、変更を一括送信して閉じるAPI。現在は機能フラグにより `423`。
- `POST /api/osm/plans/:planId/delete-elements`: 現在は必ず `423`。
- `POST /api/osm/plans/:planId/execute-revert`: 取消changesetを送信するAPI。現在は機能フラグにより `423`。
- `GET /api/osm/audit-events`: 管理者キーが必要な追記型監査履歴一覧。

変更案の各要素には `elementType` (`node|way|relation`)、`action` (`create|modify|delete`)、既存要素なら `osmId` と `version`、復元に必要な `before` と `after` を保存する。変更案と監査イベントにはUPDATE・DELETEを拒否するDBトリガーが設定される。

送信には次の条件がすべて必要となる。

1. サーバー環境変数 `OSM_WRITES_ENABLED=true`
2. 32文字以上の管理者キー
3. リクエストヘッダーと本文の両方に `execute PLAN_ID` または `execute-revert PLAN_ID` という対象限定確認
4. OSM API URLとアクセストークン
5. 送信開始前の追記型監査イベント保存

送信直前には変更・削除対象を再取得し、OSM上の現在Versionと変更案のVersionが一致しなければ `409 osm_version_conflict` で停止する。取消しでも同じ検査を行い、第三者の後続編集を自動上書きしない。

アクセストークン、管理者キー、CookieはDBの変更案・監査履歴へ保存しない。
