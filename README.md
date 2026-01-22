# Barrierfree Map

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
