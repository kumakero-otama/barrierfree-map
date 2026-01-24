# PWA 自動更新ガイド

## 概要
このPWAアプリケーションは、コード更新時にクライアント側が自動的に更新されるように設定されています。

## 実装内容

### 1. Service Worker (public/sw.js)
- **キャッシュバージョニング**: `CACHE_VERSION`変数でバージョン管理
- **即座のアクティブ化**: `skipWaiting()`で新しいService Workerを即座にアクティブ化
- **古いキャッシュの削除**: アクティブ化時に古いキャッシュを自動削除
- **クライアント制御**: `clients.claim()`で既存のクライアントをすぐに制御

### 2. PWA登録 (public/pwa.js)
- **自動リロード**: Service Worker更新時にページを自動リロード
- **定期更新チェック**: 1分ごとに更新をチェック
- **即座の更新チェック**: ページ表示時とフォーカス時に更新をチェック
- **自動アクティブ化**: 新しいService Workerを自動的にアクティブ化

## コード更新時の手順

### 方法1: バージョン番号を変更（推奨）
HTMLやCSS、JavaScriptファイルを更新した場合：

1. `public/version.js`の`APP_VERSION`を変更します：
```javascript
const APP_VERSION = "1.0.2"; // バージョンを上げる
```

2. `public/sw.js`の先頭にある`CACHE_VERSION`も同じバージョンに変更します：
```javascript
const CACHE_VERSION = "1.0.2"; // バージョンを上げる
```

**注意**: 両方のファイルのバージョンを同じ値に変更してください。

### 方法2: 自動更新（sw.jsを変更した場合）
Service Worker自体を変更した場合、ファイルの変更が自動的に検出されます。

## 動作の流れ

1. サーバーにコードをデプロイ
2. クライアントがページを開く/フォーカスする（または1分経過）
3. 自動的に更新をチェック
4. 新しいService Workerをダウンロード・インストール
5. 即座にアクティブ化
6. ページを自動リロード
7. 新しいバージョンが表示される

## デバッグ方法

ブラウザの開発者ツールのコンソールで以下のログを確認できます：

- `[SW] Installing new service worker...` - インストール開始
- `[SW] Activating new service worker...` - アクティブ化開始
- `[SW] Deleting old cache: ...` - 古いキャッシュ削除
- `[PWA] Service Worker registered` - 登録完了
- `[PWA] New service worker found` - 新しいバージョン検出
- `[PWA] New service worker activated, reloading...` - リロード開始

## 注意事項

- 初回訪問時はキャッシュがないため、通常のロードが行われます
- オフライン時は最後にキャッシュされたバージョンが表示されます
- `/api/`で始まるパスはキャッシュされません（常に最新データを取得）
- ブラウザによってはService Workerの動作が異なる場合があります

## トラブルシューティング

### 更新が反映されない場合

1. **手動でキャッシュをクリア**:
   - Chrome: 開発者ツール → Application → Storage → Clear site data
   - Firefox: 開発者ツール → Storage → Clear All
   
2. **Service Workerを手動で削除**:
   - Chrome: 開発者ツール → Application → Service Workers → Unregister
   - Firefox: 開発者ツール → Application → Service Workers → Unregister

3. **スーパーリロード**:
   - Windows/Linux: `Ctrl + Shift + R`
   - Mac: `Cmd + Shift + R`

4. **CACHE_VERSIONが変更されているか確認**:
   ```bash
   grep "CACHE_VERSION" public/sw.js
   ```

## テスト方法

1. サーバーを起動:
```bash
npm start
```

2. ブラウザで開く:
```
http://localhost:3000
```

3. HTMLファイルを変更

4. `public/sw.js`の`CACHE_VERSION`を変更

5. ブラウザをリロード（F5）

6. 数秒後に自動的にページが再読み込みされ、変更が反映されることを確認
