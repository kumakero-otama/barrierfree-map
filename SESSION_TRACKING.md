# UI10記録セッション

## 現在の流れ

1. Google認証済み利用者または個別識別されたゲストが記録を開始
2. ブラウザが`session_id`（UUID）を生成
3. GPS生座標と`accuracy`を取得
4. ブラウザ内JavaScriptが約1km圏のOSM道路網へフィッティング
5. OSM Way上で連続する経路を確定
6. 保存操作後、永続キューからStepBy APIへ送信
7. PostgreSQLへGPS raw、フィット点、経路、Way ID/Version/形状、タグを保存
8. 公開対象の点字ブロックだけ、StepBy専用OSMアカウントからOSMへ送信

通常のUI10記録はMapboxやValhallaを使用しません。

## 主なAPI

- `POST /api/session/start`: セッション開始
- `POST /api/session/end`: 終了日時を保存
- `POST /api/session/cancel`: 未確定セッションを取り消す
- `POST /api/session/deactivate`: StepBy上で論理削除
- `POST /api/session/memo`: 本人限定メモを更新
- `POST /api/trace/record`: GPS raw、フィット点、経路、Wayスナップショットを保存
- `GET /api/records`: 表示可能な保存経路を取得
- `POST /api/osm/records/{recordId}/publish`: 公開対象記録をOSMへ送信
- `POST /api/osm/records/{recordId}/revert`: 本人所有記録を反対変更で取り消す

正確なrequest/responseは[`documents/API_list.md`](documents/API_list.md)と[`public/docs/openapi.yaml`](public/docs/openapi.yaml)を参照してください。

## DB対応

- `tactile.sessions`: 記録者、開始・終了、本人限定メモ、有効状態
- `tactile.gps_raw`: 時刻、GPS生座標、accuracy
- `tactile.gps_matched`: フィット座標、Way等の対応
- `tactile.session_paths`: 確定経路
- `tactile.session_path_edges`: 経路のWay順
- `tactile.way_snapshots`: 送信判断時のWay ID、Version、Node、形状、タグ
- `osmchange.record_links`: 記録、変更案、送信changeset、取消changesetの対応
- `osmchange.audit_events`: 追記型の処理履歴

利用者が異なる場合は、同じStepBy専用OSMアカウントで編集されても、PostgreSQLの`user_id`で記録者を区別します。

## 公開範囲

- 点字ブロック系公開タグ: OSM送信対象
- 柵、塀、グレーチング、その他の非公開タグ: 記録者本人だけに表示
- ひとことメモ: 記録者本人だけに表示

非公開情報はOSM変更案・changeset・他人向けAPI応答へ含めません。
