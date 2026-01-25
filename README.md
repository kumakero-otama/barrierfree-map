# Barrierfree Map

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
`ecosystem.config.js`に書いた2つのサービス（`server.js`と`loophole`）を同時に起動します。

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
pm2 logs barrierfree-map-loophole
```

どのディレクトリからでも実行できます。2つのサービスのログを表示します。

### 停止 / 再起動

```bash
pm2 stop barrierfree-map-server barrierfree-map-loophole
pm2 restart barrierfree-map-server barrierfree-map-loophole
```

どのディレクトリからでも実行できます。指定したサービスを停止または再起動します。
