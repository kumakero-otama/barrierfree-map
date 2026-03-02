# フロント移行 手順書（中学生の初心者向け）

この手順書は、次の4つを進めるためのものです。

1. 認証まわりを変更する（Cookie中心 -> Bearerトークン中心）
2. Swagger（OpenAPI）に対応する
3. 新しいGitHubリポジトリを作り、`public/` をコピーして GitHub Pages で公開する
4. 新しいリポジトリに、デザイン変更版フロントも作って「別アプリ」として動かす

---

## 0. まず理解すること

- 今のリポジトリは消しません（現行フロントも残す）
- ただし **現行フロントの認証方法も変更** します
- 別リポジトリで GitHub Pages 公開用フロントを運用します
- 2つのフロント（現行と新リポジトリ）を並行運用します

---

## 1. 全体の作業順（これだけ覚えればOK）

1. バックエンドに Bearer 認証の仕組みを追加
2. 現行フロントの API 呼び出しを Bearer 方式に変更
3. Swagger を追加（API仕様書を見える化）
4. 新しいフロント用GitHubリポジトリ作成
5. `public/` をコピーして GitHub Pages で公開
6. 同じ新リポジトリ内にデザイン違いをもう1つ作る
7. 2つのデザインが別アプリとして動くか確認

---

## 2. 認証まわり変更（現行リポジトリ）

## 2-1. 目的

- これまで: Cookieでログイン維持
- これから: `Authorization: Bearer <token>` で認可

## 2-2. ざっくり流れ

1. フロントが Google ログインで `id_token` を取得
2. `POST /auth/google` に `id_token` を送る
3. サーバーが検証して `access_token` を返す
4. フロントが `access_token` を保存
5. API呼び出し時に `Authorization` ヘッダを付ける

## 2-3. 実装チェックリスト

- [ ] サーバーに `POST /auth/google` がある
- [ ] `id_token` を検証している（`aud`, `iss`, `exp`, `sub`）
- [ ] `access_token` 発行処理がある
- [ ] 認証が必要なAPIで Bearer 検証ミドルウェアを通している
- [ ] フロントの `fetch` から `credentials: "include"` 依存を減らした
- [ ] フロントが `Authorization: Bearer ...` を付与している

---

## 3. Swagger対応（現行リポジトリ）

## 3-1. 目的

- APIのルールを文章ではなく「機械が読める仕様」にする
- フロントとバックエンドのズレを減らす

## 3-2. 最低限やること

- [ ] `openapi.yaml` を作る
- [ ] `POST /auth/google` を記述
- [ ] Bearer 認証（securitySchemes）を記述
- [ ] 主要APIのリクエスト/レスポンス/エラーを記述
- [ ] Swagger UI を `/docs` などで表示

## 3-3. ファイル配置の例

```text
server/
  docs/
    openapi.yaml
```

---

## 4. 新しいGitHubリポジトリを作る（Pages用）

## 4-1. 新リポジトリの準備

例: `barrierfree-map-frontend`

```bash
# GitHubで新リポジトリ作成後
git clone <新リポジトリURL>
cd barrierfree-map-frontend
```

## 4-2. 現行の public をコピー

```bash
# 現行リポジトリのルートで実行（例）
cp -r public/* ../barrierfree-map-frontend/
```

## 4-3. GitHub Pages 対応ポイント

- [ ] 画像やJS/CSSのパスを相対パス中心にする
- [ ] APIの向き先を `https://<xxxx>.loophole.site` にする
- [ ] Pages の公開URL（`/<repo>/`）を前提にテストする

## 4-4. 公開

```bash
git add .
git commit -m "Initial frontend for GitHub Pages"
git push origin main
```

GitHub の `Settings > Pages` で公開設定をONにする。

---

## 5. デザイン変更版をもう1つ作る（同じ新リポジトリ）

## 5-1. おすすめ構成

```text
/
  index.html
  prod/
    index.html
    manifest.webmanifest
    sw.js
  design-a/
    index.html
    manifest.webmanifest
    sw.js
```

## 5-2. 注意（重要）

- ルート `/` に `sw.js` を置かない
- 各フォルダごとに `sw.js` を置く
- `manifest.webmanifest` の `start_url` と `scope` は `./`
- `name`, `short_name` は別名にする

これで `prod` と `design-a` を「別アプリ」として扱えます。

---

## 6. 動作確認（最終チェック）

## 6-1. 認証確認

- [ ] Googleログインできる
- [ ] `access_token` を受け取れる
- [ ] 認証付きAPIが Bearer で成功する

## 6-2. Pages確認

- [ ] `https://<user>.github.io/<repo>/prod/` が開く
- [ ] API通信が loophole に届く

## 6-3. デザイン分離確認

- [ ] `.../prod/` と `.../design-a/` が両方動く
- [ ] 片方の変更がもう片方に影響しない

---

## 7. 失敗しやすいポイント

- Cookie前提コードが残っている
- `Authorization` ヘッダを付け忘れる
- GitHub Pages の `/<repo>/` パスを考慮していない
- Service Worker をルートに置いて全体を巻き込む

---

## 8. 参考ドキュメント

- [Frontend_Migration_GitHub_Pages_Spec.md](/home/otama/barrierfree-map/documents/Frontend_Migration_GitHub_Pages_Spec.md)

