# Barrierfree Map

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

**注意:** バージョン更新後は、PM2でサーバーを再起動してください。
```bash
pm2 restart barrierfree-map-server
```

## 環境変数の設定

アプリケーションの動作を制御するために、環境変数を設定できます。

### .envファイルの作成

```bash
cp .env.example .env
```

`.env.example`をコピーして`.env`ファイルを作成し、必要に応じて値を編集してください。

### レート制限の設定

- **MIN_INTERVAL_MS** (デフォルト: 4000)
  - サーバー側のレート制限（ミリ秒）
  - 同一デバイスからのリクエスト間の最小間隔

- **CLIENT_MIN_INTERVAL_MS** (デフォルト: 5000)
  - クライアント側のレート制限（ミリ秒）
  - サーバー側より長めに設定することを推奨

例：
```bash
MIN_INTERVAL_MS=4000
CLIENT_MIN_INTERVAL_MS=5000
```

設定を変更した後は、サーバーを再起動してください。

## PM2

### インストール

```bash
npm install -g pm2
```

Node.jsのプロセスマネージャーであるPM2をグローバルに入れます。

### 起動

```bash
pm2 start ecosystem.config.js
```

`barrierfree-map`のプロジェクトルート（`ecosystem.config.js`がある場所）で実行します。
`ecosystem.config.js`に書いたサービス（`server.js`）を起動します。外部公開は Tailscale Funnel を使用します（詳細は documents/loophole_to_tailscale_migration.md 参照）。

### 再起動後の復元

```bash
pm2 save
```

`barrierfree-map`のプロジェクトルートで実行します。現在動いているPM2プロセス一覧を保存します。
OS再起動後に同じ構成で復元されます。

### 自動起動の有効化（OS起動時）

```bash
pm2 startup
```

どのディレクトリからでも実行できます。OS起動時にPM2自体を起動する設定を作ります。
表示される指示があれば実行してください。

### ログ確認

```bash
pm2 logs barrierfree-map-server
```

どのディレクトリからでも実行できます。サービスのログを表示します。

### 停止 / 再起動

```bash
pm2 stop barrierfree-map-server
pm2 restart barrierfree-map-server
```

どのディレクトリからでも実行できます。指定したサービスを停止または再起動します。
