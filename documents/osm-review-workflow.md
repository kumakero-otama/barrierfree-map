# OSM公開前審査

更新日: 2026-08-24

## 目的

点字ブロック記録を保存直後にOSMへ送らず、PostgreSQLの審査キューへ保存します。管理者が航空写真、GPS生座標、フィット経路、対象Wayと変更予定タグを確認し、承認した記録だけをStepBy専用OSMアカウントから送ります。

## 対象

- Google認証ユーザーのOSM公開対象となる点字ブロック記録: 審査待ちへ登録
- ゲストユーザーの記録: StepBy DBにのみ保存し、審査・OSM送信の対象外
- PROモードの本人限定タグとひとことメモ: OSMへ送信しない
- 旧ローカルDB: 328記録のうち経路あり276件を一次候補、経路なし52件を要調査

## 管理者

Google認証メールが `kumakero.otama@gmail.com` と一致するStepByユーザーだけが審査APIを利用できます。照合はクライアント表示ではなくサーバーの `login.user_auth_providers` で行います。

## 状態

- `pending`: 確認待ち
- `approved`: 管理者承認済みだが安全条件または機能フラグにより未送信
- `rejected`: 却下。理由を保存し再審査可能
- `merge_failed`: 送信失敗。履歴を残して再試行可能
- `merged`: OSM送信成功

すべての判断は `osmchange.review_events`、通知は `osmchange.review_notifications`、OSM変更は既存の `osmchange.audit_events` へ記録します。監査イベントは更新・削除できません。

## 通知

審査待ち1件ごとに `kumakero.otama@gmail.com` へ送ります。Gmail SMTPの資格情報はSecret Managerから環境変数へ注入し、Gitには保存しません。通知失敗は記録保存を失敗させず、通知だけを `failed` として残します。

## 安全条件

承認しても、サーバー側機能フラグ、StepBy専用OSMアカウント、追記監査、冪等性、最新Version、opt-out、競合停止が揃わなければOSMへ送りません。開発・自動試験ではOSMネットワークを使用しません。

## 管理画面

- GitHub Pages候補: `UI11/admin/osm-review.html`
- API同一Origin版: `/admin/osm-review.html`
- 航空写真: 国土地理院シームレス空中写真
- 半透明のOSM地図、GPS生座標、保存経路、変更対象を重ねて表示

