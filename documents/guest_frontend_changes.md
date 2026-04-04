# Guest Frontend Changes

このファイルは、バックエンド側で Guest アカウント作成と Guest セッション発行を追加した前提で、`public/` 配下で必要になる変更点をまとめたものです。

## 目的

- アカウント登録なしでアプリを使えるようにする
- 画面上の名前は常に `Guest`
- アイコン画像は表示しない
- 既存の記録API・投稿APIはそのまま使う

## バックエンド側で追加された前提

- `POST /auth/guest`
  - Guest ユーザーを新規作成するか、既存の Guest セッションを再利用する
  - `access_token` を返す
  - `session` Cookie も発行する
- `GET /auth/me`
  - Guest セッションなら `user.isGuest = true` を返す
  - `username` は `Guest`
  - `iconUrl` は `null`
- `POST /auth/profile`
  - Guest では `403 { error: "guest_profile_locked" }`
- `PUT /api/pro-status`
  - Guest では `403 { error: "guest_pro_locked" }`

## `public/` で必要な変更

### 1. ログイン画面に「ゲストで続ける」を追加する

対象:

- `public/auth/login.html`
- `public/auth/auth.js`

内容:

- Google ログインボタンとは別に「ゲストで続ける」ボタンを追加する
- 押したら `POST /auth/guest` を呼ぶ
- 返ってきた `access_token` を今の `AuthToken.setAccessToken()` に保存する
- 成功したら `/map/Index.html` に遷移する

### 2. Guest 状態をプロフィール画面で表示する

対象:

- `public/profile/profile.js`
- 必要なら `public/profile/Index.html`

内容:

- `/auth/me` の `user.isGuest` を見る
- `isGuest === true` のとき:
  - 名前を `Guest` と表示する
  - アイコンは画像を出さない
  - 編集ボタンを隠すか無効化する
  - ログアウトボタンはそのままでよい
  - PRO バッジと PRO 切替は隠すか無効化する

補足:

- いまはデフォルト画像 `/assets/account_default.png` を出しているので、Guest だけは出さない分岐が必要

### 3. プロフィール編集画面に入れないようにする

対象:

- `public/profile/profile.js`
- `public/profile/edit.js`

内容:

- Guest なら編集画面への遷移を止める
- URL 直打ちで `edit.html` に入っても、`/auth/me` を見て Guest なら
  - プロフィール画面へ戻す
  - または「Guest は編集できません」と表示する

補足:

- バックエンドでも `POST /auth/profile` を拒否するが、UI 側でも編集不可にした方がわかりやすい

### 4. サインアップ導線との役割を分ける

対象:

- `public/auth/login.html`
- `public/auth/signup.html`
- `public/auth/auth.js`

内容:

- Guest は「使い始めるための簡易モード」
- Google サインアップは「正式アカウント作成」

UI 上では:

- ログイン画面:
  - Google でログイン
  - ゲストで続ける
- サインアップ画面:
  - Google で新規登録

に分けるとわかりやすい

### 5. Guest の表示ルールを統一する

対象候補:

- `public/profile/profile.js`
- `public/road_info_detail/road_info_detail.js`
- `public/map/map.js`
- `public/post_road/Index.html` に対応する JS
- 記録一覧や投稿一覧を描画する JS

内容:

- `user.isGuest` または `authorUsername === "Guest"` のときは、表示名を常に `Guest` にそろえる
- アイコンURLが `null` のとき:
  - Guest なら「画像なし」で表示
  - 通常ユーザーなら既存のデフォルト画像表示でもよい

### 6. Guest のときだけ出し分けるもの

対象:

- `public/profile/profile.js`
- 各画面のメニュー制御

内容:

- Guest に不要な機能は隠す
  - プロフィール編集
  - PRO 切替
  - 将来もし追加されるならメール確認やアカウント設定

### 7. 将来の本登録導線を用意するか決める

これは今すぐ必須ではないが、あとで仕様決定が必要です。

候補:

- Guest のまま使い続ける
- Guest から Google ログインして正式アカウントへ切り替える
- Guest の記録や投稿を正式アカウントへ引き継ぐ

引き継ぎをする場合は、将来バックエンド追加が必要です。

## フロント実装時の基本フロー

1. ユーザーがログイン画面で「ゲストで続ける」を押す
2. フロントが `POST /auth/guest` を呼ぶ
3. 返ってきた `access_token` を保存する
4. 地図画面へ遷移する
5. `GET /auth/me` では `isGuest = true` のユーザーが返る
6. プロフィール画面では `Guest` / アイコンなし / 編集不可にする

## 注意点

- Guest は内部的には通常の数値 `user_id` を持つ
- 画面表示だけ `Guest` にする
- そのため、既存の `/api/session/*` や `/api/road-info` は基本的にそのまま使える
- ただし Guest の見た目を正しくするには、`public/` 側の表示分岐が必要
