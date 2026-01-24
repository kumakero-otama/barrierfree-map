# セッション追跡機能

## 概要

フィッティング機能がONの期間を1つのセッションとして記録し、その間のフィット後の座標を時系列で保存する機能です。

## 機能説明

### セッション管理

- **セッション開始**: フィッティングボタンをONにするとセッションが開始されます
- **座標記録**: フィッティングがONの間、MapboxのMap Matching APIでスナップされた座標を順次記録します
- **セッション終了**: フィッティングボタンをOFFにするとセッションが終了します

### データ構造

#### sessionsテーブル
- `id`: 自動採番されるプライマリーキー
- `session_uuid`: クライアントで生成されるUUID（セッション識別用）
- `user_id`: ユーザーを識別するUUID（localStorage に保存）
- `started_at`: セッション開始時刻
- `ended_at`: セッション終了時刻
- `note`: メモ（オプション）

#### session_pointsテーブル
- `id`: 自動採番されるプライマリーキー
- `session_id`: sessionsテーブルへの外部キー
- `seq`: ポイントのシーケンス番号（0から開始）
- `lat`: 緯度（スナップ後）
- `lng`: 経度（スナップ後）
- `created_at`: 記録時刻

## API エンドポイント

### セッション開始
```
POST /api/session/start
Content-Type: application/json

{
  "sessionUuid": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
  "userId": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
}
```

**レスポンス:**
```json
{
  "success": true,
  "sessionId": 123,
  "sessionUuid": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
}
```

### 座標保存
```
POST /api/session/point
Content-Type: application/json

{
  "sessionUuid": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
  "lat": 35.681236,
  "lng": 139.767125,
  "seq": 0
}
```

**レスポンス:**
```json
{
  "success": true
}
```

### セッション終了
```
POST /api/session/end
Content-Type: application/json

{
  "sessionUuid": "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx",
  "note": "オプションのメモ"
}
```

**レスポンス:**
```json
{
  "success": true
}
```

## データベースセットアップ

### 新規テーブル作成
TABLE_DDL.mdを参照してテーブルを作成してください。

### 既存テーブルへのマイグレーション
既に`sessions`テーブルが存在する場合は、マイグレーションSQLを実行してください：

```bash
mysql -u [user] -p [database] < migrations/001_add_session_uuid.sql
```

## クライアント側の実装

### UUID生成
各セッションとユーザーには、クライアント側で生成されたUUIDv4が割り当てられます。

### ユーザーID管理
ユーザーIDは`localStorage`に`otamap_user_id`として保存され、初回アクセス時に自動生成されます。

### セッションフロー
1. ユーザーが「Fitting: OFF」ボタンをクリック
2. ボタンが「Fitting: ON」に変わり、セッション開始APIが呼ばれる
3. フィッティング中、5秒ごとに座標が取得され、スナップされた座標がセッションに保存される
4. ユーザーが再度ボタンをクリック
5. ボタンが「Fitting: OFF」に戻り、セッション終了APIが呼ばれる

## 複数端末・複数ユーザー対応

- **セッションUUID**: 各セッションに一意のUUIDを付与することで、複数の端末や複数のユーザーからの同時アクセスに対応しています
- **ユーザーID**: 端末ごとに一意のユーザーIDを生成し、どの端末からのセッションかを識別できます
- **セッションID (Auto Increment)**: データベース内部での管理用IDは自動採番されますが、クライアントはsession_uuidを使用して特定のセッションを識別します

## 注意事項

- フィッティングがOFFの場合、座標はセッションに保存されません
- セッションが既に終了している場合、座標の保存はエラーになります
- データベース接続が利用できない場合、APIはエラーを返します
- config.yamlにデータベース設定が必要です

## データベース設定

`config.yaml`に以下の設定が必要です：

```yaml
db:
  host: localhost
  port: 3306
  user: your_db_user
  password: your_db_password
  database: your_database_name
```

## 今後の拡張案

- セッション一覧表示機能
- セッションの軌跡を地図上に表示する機能
- セッションデータのエクスポート機能（GPX、GeoJSON等）
- セッション統計情報の表示
