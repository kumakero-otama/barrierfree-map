
### OSM変更API（StepBy専用OSMアカウント方式・送信ロック中）

変更案、送信、取消送信、監査履歴を扱う。各利用者のOSM OAuthではなく、サーバーがSecret Managerから取得するStepBy専用OSMアカウントでchangesetを作成する。StepBy利用者はGoogle認証だけを行い、利用者・session・changesetの対応は内部監査へ保存する。専用トークン、Wiki URL、コミュニティ承認、書込みフラグがすべて揃うまで送信はロックされる。

専用アカウントの初回認証は開発管理画面から開始する。OSM公式OAuth画面で `read_prefs write_api` を許可し、返されたトークンだけをAES-256-GCMで暗号化してDBへ保存する。暗号鍵はSecret Managerから注入する。OSMのメールアドレスやパスワードはStepByへ入力・保存しない。管理者が入力したOSM表示名と認証結果が一致しない場合、トークンは保存しない。個人OSMアカウントの既存セッションはログアウトしない。

- `GET /api/osm/status`: 安全装置の状態を取得する。
- `POST /api/osm/plans`: `merge`、`delete`、`revert` の変更案を追記保存する。
- `POST /api/osm/split-plan`: Way途中の開始・終了位置から、Node作成、Way分割、`tactile_paving=yes` の変更案を作る。
- `POST /api/osm/records/:recordId/publish`: 記録所有者が保存を確定した1件を、StepBy専用OSMアカウントで送信する。本文は `authorization: record_save`。同じ記録の再要求は既存changesetを返し、二重送信しない。
- `POST /api/osm/records/:recordId/revert`: 記録所有者がStepBy由来の緑線の削除を確定した1件について、反対変更案の作成と取消changeset送信を行う。本文は `authorization: owned_green_line_delete`。青線・他人の記録・対応不明の地物にはフロントから操作を出さず、APIも所有者確認で拒否する。
- `GET /api/osm-tactile-ways`: 公開OSMの点字ブロック表示に加え、現在接続中のOSM環境への送信成功を追記型監査履歴で確認できるStepBy記録を、開発DBの確定経路から緑線として補完する。本人の線にだけ取消対象の記録IDを付与する。
- `GET /api/osm/plans/:planId`: 変更案と監査イベントを取得する。作成者または管理者のみ。
- `POST /api/osm/plans/:planId/revert-plan`: 送信結果のOSM ID・Versionを使い、反対変更を新規作成する。元プランが未送信なら、実行不能の確認用テンプレートだけを作る。
- `POST /api/osm/plans/:planId/approve`: 現在は必ず `423`。
- `POST /api/osm/plans/:planId/execute`: changesetを作成し、変更を一括送信して閉じるAPI。現在は機能フラグにより `423`。
- `POST /api/osm/plans/:planId/delete-elements`: 現在は必ず `423`。
- `POST /api/osm/plans/:planId/execute-revert`: 取消changesetを送信するAPI。現在は機能フラグにより `423`。
- `GET /api/osm/audit-events`: 管理者キーが必要な追記型監査履歴一覧。

変更案の各要素には `elementType` (`node|way|relation`)、`action` (`create|modify|delete`)、既存要素なら `osmId` と `version`、復元に必要な `before` と `after` を保存する。変更案と監査イベントにはUPDATE・DELETEを拒否するDBトリガーが設定される。

一般利用者の保存・緑線削除による送信には次の条件がすべて必要となる。

1. `OSM_WRITES_ENABLED=true` かつ `OSM_COMMUNITY_APPROVED=true`
2. ログイン利用者が対象StepBy記録の所有者であること
3. 保存または緑線削除の対象限定authorization
4. StepBy専用OSMアカウントのトークン、表示名、Automated Edits Wiki URLがSecret／設定として存在すること
5. 送信開始前の追記型監査イベント保存
6. 記録ID単位の冪等性とOSM Version一致

changesetには人間が読めるcomment、`#StepBy`、`mechanical=yes`（協議結果により`bot=yes`）、Automated Edits Wikiへのリンク、`source=survey`を付ける。StepBy内部user IDやplan IDはOSMへ公開しない。

既存データ一括移行など一般利用者の保存・削除に直接対応しない管理者APIは、従来どおり管理者キーとplan ID単位の直前確認を必要とする。

送信直前には変更・削除対象を再取得し、OSM上の現在Versionと変更案のVersionが一致しなければ `409 osm_version_conflict` で停止する。取消しでも同じ検査を行い、第三者の後続編集を自動上書きしない。

アクセストークン、管理者キー、CookieはDBの変更案・監査履歴へ保存しない。
