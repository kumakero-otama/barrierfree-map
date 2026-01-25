# Barrierfree Map - 開発ガイド

このファイルはAIエージェントや開発者が参照する開発マニュアルです。

## バージョン管理

アプリケーションのバージョンは`package.json`で一元管理されています。

### バージョンの更新方法

1. **package.jsonのversionを変更**
   ```json
   {
     "version": "1.0.8"
   }
   ```

2. **更新スクリプトを実行**
   ```bash
   npm run version:update
   ```

このスクリプトにより、以下のファイルが自動的に更新されます：
- `public/version.js` - 画面に表示されるバージョン番号
- `public/sw.js` - Service Workerのキャッシュバージョン

**重要:** 
- バージョン番号は`package.json`のみで管理
- 他のファイルを直接編集しないこと
- バージョン更新後は必ず`pm2 restart barrierfree-map-server`を実行

## 環境変数の設定

### 利用可能な環境変数

| 変数名 | デフォルト値 | 説明 |
|--------|------------|------|
| `MAPBOX_TOKEN` | なし | Mapbox APIトークン（必須） |
| `TLS_KEY_PATH` | なし | TLS秘密鍵のパス（HTTPS使用時） |
| `TLS_CERT_PATH` | なし | TLS証明書のパス（HTTPS使用時） |
| `MIN_INTERVAL_MS` | 4000 | サーバー側のレート制限（ミリ秒） |
| `CLIENT_MIN_INTERVAL_MS` | 5000 | クライアント側のレート制限（ミリ秒） |

### 設定方法

1. `.env.example`をコピーして`.env`を作成
   ```bash
   cp .env.example .env
   ```

2. `.env`ファイルを編集
   ```bash
   MAPBOX_TOKEN=your_token_here
   MIN_INTERVAL_MS=4000
   CLIENT_MIN_INTERVAL_MS=5000
   ```

3. PM2設定（`ecosystem.config.js`）で自動的に読み込まれる

## アーキテクチャ

### クライアント側の識別情報

1. **deviceUUID（ユーザーID）**
   - ブラウザのlocalStorageに永続化されるUUID v4
   - 初回アクセス時に自動生成
   - 用途：
     - レート制限の識別（全リクエスト）
     - セッションのuser_id（Record ON時）

2. **sessionUUID（セッションID）**
   - Record ボタンをONにした時に生成
   - 用途：
     - 移動軌跡の記録セッションを識別
     - Record OFF時は送信されない

### APIリクエストフロー

```
クライアント → /api/match?lat=...&lng=...&deviceUuid=...&sessionUuid=...&seq=...
              ↓
         レート制限チェック (MIN_INTERVAL_MS)
              ↓
         Mapbox API呼び出し
              ↓
         座標のスナップ
              ↓
         DBにセッション記録（Record ON時のみ）
              ↓
         クライアントに返却
```

### データベース構造

**sessions テーブル**
- `id`: PRIMARY KEY
- `session_uuid`: セッション識別UUID（クライアント生成）
- `user_id`: deviceUUID（クライアント生成）
- `started_at`: セッション開始時刻
- `ended_at`: 最終更新時刻

**session_points テーブル**
- `id`: PRIMARY KEY
- `session_id`: sessions.idへの外部キー
- `seq`: ポイントの順序番号
- `lat`: 緯度（スナップ後）
- `lng`: 経度（スナップ後）
- `created_at`: 作成時刻

## Service Worker（PWA）

### キャッシュ戦略

- `CACHE_VERSION`は`package.json`のバージョンと同期
- バージョン変更時に自動的に古いキャッシュを削除
- `/api/`配下のリクエストはキャッシュしない

### キャッシュ更新の仕組み

1. `npm run version:update`でCACHE_VERSIONを更新
2. ユーザーがページをリロード
3. 新しいService Workerがインストール
4. 古いキャッシュが削除
5. 新しいファイルがキャッシュされる

### 完全自動更新機能

**バージョン更新時の動作:**
1. 新しいバージョンが検知されると、自動的に新しいService Workerがアクティブ化
2. ページが自動的にリロードされ、最新版が適用される
3. **ユーザーは何もする必要がありません**

**更新チェックのタイミング:**
- ページロード時（即座にチェック）
- 1時間ごと（自動チェック）
- ページにフォーカスが戻った時

**ユーザー体験:**
- ページを開くだけで、常に最新版が使用される
- 通知やボタンクリックは不要
- バックグラウンドで自動更新

**手動での強制更新:**
- `Ctrl+F5`（ハードリロード）でも強制的に最新版を取得可能
- 通常は不要

## 開発ワークフロー

### コード変更時

1. コードを変更
2. 変更がクライアント側（JS/CSS）の場合：
   ```bash
   # バージョンを上げる
   # package.jsonのversionを変更
   npm run version:update
   ```
3. サーバーを再起動
   ```bash
   pm2 restart barrierfree-map-server
   ```

### デバッグ

**クライアント側:**
- ブラウザの開発者ツール（F12）でコンソールログを確認
- `[Config]`, `[requestSnappedLocation]`, `[updateDisplay]`などのログを確認

**サーバー側:**
- PM2ログを確認
  ```bash
  pm2 logs barrierfree-map-server
  ```
- CSVログを確認
  ```bash
  tail -f logs/server.csv
  tail -f logs/sessions.csv
  tail -f logs/session_points.csv
  ```

## レート制限

### サーバー側（server/api/match.js）

- `MIN_INTERVAL_MS`（デフォルト: 4000ms）
- 同一deviceUuidからのリクエスト間隔をチェック
- 429 Too Many Requestsを返す

### クライアント側（public/map/map.js）

- `MIN_REQUEST_INTERVAL_MS`（サーバーから取得、デフォルト: 5000ms）
- サーバーへのリクエスト前にクライアント側でチェック
- 制限内の場合はリクエストを送信しない

**推奨設定:**
- クライアント側 > サーバー側（例: 5000ms > 4000ms）
- これにより、サーバー側で拒否される前にクライアント側で制限

## トラブルシューティング

### キャッシュが更新されない

**症状:** コード変更が反映されない

**解決方法:**
1. `package.json`のバージョンを上げる
2. `npm run version:update`を実行
3. サーバー再起動: `pm2 restart barrierfree-map-server`
4. ブラウザで`Ctrl+F5`（ハードリロード）

### 429エラーが頻発

**症状:** "Too Many Requests"エラー

**解決方法:**
1. `.env`ファイルでレート制限を調整
   ```bash
   MIN_INTERVAL_MS=4000
   CLIENT_MIN_INTERVAL_MS=5000
   ```
2. サーバー再起動
3. ブラウザをリロード（設定を再取得）

### 位置情報が更新されない

**症状:** "Last update"が更新されない、マーカーが動かない

**解決方法:**
1. ブラウザのコンソールでエラーを確認
2. キャッシュをクリア（`Ctrl+F5`）
3. デバッグログで`[updateDisplay]`が呼ばれているか確認

## ファイル構造

```
barrierfree-map/
├── package.json          # バージョン管理の唯一の真実の情報源
├── server.js            # メインサーバー
├── ecosystem.config.js  # PM2設定
├── .env                 # 環境変数（gitignore）
├── .env.example         # 環境変数のテンプレート
├── README.md            # ユーザー向けマニュアル
├── DEVELOPMENT.md       # 開発者向けマニュアル（このファイル）
├── scripts/
│   ├── update-version.js    # バージョン自動更新スクリプト
│   └── loophole_logger.js   # Loopholeロガー
├── server/
│   ├── db.js            # DB接続
│   ├── logger.js        # ロガー
│   └── api/
│       ├── match.js     # マッチング/フィッティングAPI
│       ├── count.js     # カウントAPI
│       ├── session.js   # セッションAPI
│       └── config.js    # 設定API
└── public/
    ├── version.js       # バージョン表示（自動生成）
    ├── sw.js           # Service Worker（自動生成）
    └── map/
        ├── map.js      # マップクライアント
        └── index.html  # マップページ
```

## 重要な注意事項

1. **バージョン管理**
   - `public/version.js`と`public/sw.js`を直接編集しないこと
   - 必ず`package.json`を変更して`npm run version:update`を実行

2. **環境変数**
   - `.env`ファイルはgitにコミットしない
   - 本番環境では適切な値を設定

3. **レート制限**
   - クライアント側 > サーバー側に設定
   - Mapbox APIの制限にも注意

4. **Service Worker**
   - バージョン変更時は必ずユーザーに通知
   - ハードリロードを案内
