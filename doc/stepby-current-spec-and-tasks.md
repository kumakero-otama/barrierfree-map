# StepBy 現行仕様・運用状態・今後のタスク

最終更新: 2026-08-29（Asia/Tokyo）
対象: 正式版 StepBy UI0 / Google Cloud API
この文書は、現在の確定仕様、実装済み機能、既知の問題、残作業、主要リンクを一か所にまとめた引継ぎ資料です。

## 1. 現在の位置づけ

- 公開中の正式版はUI0です。通常のフィッティングではValhallaを使わず、ブラウザ内でOSM道路網へフィッティングします。
- 記録中に道情報投稿画面へ移動しても、`POST /api/session/point`でGPS生座標だけを継続保存します。マップへ戻った後に点列を復元してブラウザ内でフィッティングし、旧`/api/match?record=1`は使用しません。
- UI0のフロントエンドはGitHub Pages、APIとDBはGoogle Cloudの`stepby-dev-1`で稼働しています。VM・サービス・DBの`dev`を含む名前は移行前から継続する内部識別子です。
- フロントエンドは`StepBy/main`のUI0、バックエンドの公開・再現基準は`barrierfree-map/main`です。今後のバックエンド開発は`dev`で行い、確認後にmainへ昇格します。
- UI0のOSM送信先は本番OpenStreetMapです。編集はサーバーで認証したStepBy専用OSMアカウント（表示名 `StepBy`）から行います。
- 開発用OSMの旧OAuthトークンは、本番切替時に監査履歴を残して失効させました。

## 2. 一般利用者の操作仕様

### 2.1 アカウント作成

1. Google認証でStepByへログインします。
2. 初回プロフィール登録時に、利用規約とプライバシーポリシーをリンクから閲覧できます。
3. 両方への同意チェックがない場合、StepByアカウントを作成できません。
4. 一般ユーザーは個人のOSMアカウントを作成・連携する必要がありません。
5. Google認証後はそのままStepByを利用でき、OSMのログイン画面は表示しません。

### 2.2 点字ブロック記録

1. 利用者は「記録」を押して歩き、「停止」後の確認画面で「保存」を押します。
2. 道路の左・右は利用者に質問せず、GPS軌跡、accuracy、OSM Way方向からアプリが自動判定します。
3. 確定後のDB保存と管理者審査待ち登録は端末内の永続キューでバックグラウンド処理します。
4. 通信断・画面遷移・アプリ再起動後も再試行し、完了済み工程は繰り返しません。
5. Google認証利用者のOSM公開対象記録は管理者審査待ちに入り、管理者が航空写真とOSMを確認して承認したものだけ本番OSMへ送信します。ゲスト記録はOSMへ送りません。

### 2.3 OSM取消し

- StepBy由来の本人所有の緑線だけに「この記録を削除」を表示します。
- 削除確認は、その1記録に限定したOSM取消し許可として扱います。
- 取消しは履歴削除ではなく、現在Versionを確認して反対変更を新しいchangesetで送ります。
- Wayを途中分割した記録の取消しでは、元Wayを分割前のNode列・タグへ戻し、分割時に作ったWayと境界Nodeを削除し、変更したRelationも元のmember構成へ戻します。
- 第三者による後続編集やVersion競合がある場合、自動上書きせず停止します。
- 取消し成功後はStepBy通常地図からも対象線を非表示にしますが、生GPS・監査履歴・changeset対応は保持します。
- 青線、他人の緑線、OSMとの対応が不明な線は削除できません。

## 3. フィッティング仕様

- 現在地周辺約1kmの歩行可能なOSM Way・Node・Relationをブラウザへ読み込みます。
- 取得中心から650m以上移動した場合、次の約1km範囲をバックグラウンド取得します。
- 取得済み道路網はIndexedDBへ30分保存し、Way IDごとに新しいVersionを優先して統合します。
- 記録の保存直前はブラウザとAPIサーバーの道路網キャッシュを強制的に回避し、現在のOSM Way・Versionを再取得してから最終経路を確定します。
- GPS点は最寄りの道路・歩道候補へ投影し、道路と歩道が近い場合は歩道を優先します。
- 前回Wayとの連続性と、共有Nodeで接続したOSM上の一本の経路であることを必須とします。
- accuracyが25mを超える低精度点は、前後の信頼できる点から矛盾のない位置を補間します。補間できない点、60m以内に候補がない点は破棄します。
- 必須合格条件は、網羅率80%以上、経路連続、歩道優先違反0、処理5秒以内、破棄20%以下です。
- 500 Way・GPS 1000点の自動試験では約30ms以内でした。
- OSM点字ブロックの表示はフィッティング用道路網と分離し、最大10kmを都度読み込みます。

## 4. OSMへ送る内容

### 4.1 独立した歩道Way

- 対象区間をWay途中で分割します。
- 点字ブロック区間へ `tactile_paving=yes` を付けます。

### 4.2 道路中心線上で左右を表す場合

- 独立した歩道Wayがなく、歩行可能な道路中心線へ経路が確定した場合もOSM送信対象にします。
- 右側: `sidewalk:right:tactile_paving=yes`
- 左側: `sidewalk:left:tactile_paving=yes`
- 左右はGPS軌跡とOSM Node順からアプリが自動判定し、判定不能なら送信しません。
- `motorway`、歩行禁止、立入禁止・私有の道路は対象外です。

### 4.3 Way分割

- 記録開始・終了がWay途中の場合、新しい境界Nodeを作成します。
- 元WayのNode順、道路タグ、Relationのmember順・role・タグを引き継ぎます。
- 元Wayの `source=YahooJapan/ALPSMAP` なども、道路の由来を失わないよう分割先へ引き継ぎます。
- StepByによる今回の現地調査元はchangeset側の `source=survey` と `#StepBy` で区別します。

### 4.4 Changeset

- `created_by=StepBy <アプリ版>`
- `source=survey`
- `mechanical=yes`
- `description=<公開中のStepBy OSM編集仕様URL>`
- `comment=<人が読める操作概要> #StepBy`

StepBy内部のユーザーID、記録ID、Plan IDはOSMへ公開せず、PostgreSQLの追記型監査履歴だけで対応付けます。

過去のchangeset `187377001` には旧コメント「OSM未送信」が残っています。閉じたchangesetのコメントは変更できないため、履歴としてそのまま保持します。

## 5. PostgreSQLに保存する内容

OSMへ送信した場合も、以下をStepBy開発DBへ保存します。

- `tactile.gps_raw`: 生GPS座標、取得日時、accuracy、セッションID
- `tactile.gps_matched`: フィッティング後の座標、Way/edge、confidence
- `tactile.session_paths`: 確定経路の形状
- `tactile.way_snapshots`: Way ID、Version、Node ID列、全座標、開始終了、元タグ、Relation、左右、予定タグ
- `osmchange.change_plans`: OSM変更前後と操作一覧
- `osmchange.record_links`: StepBy記録、送信changeset、取消changesetの対応
- `osmchange.audit_events`: 要求、許可、変更、成功、失敗、競合、取消し結果
- `login.osm_service_account`: StepBy専用OSMアカウントの暗号化OAuthトークンと連携状態
- `login.osm_service_account_audit`: 専用アカウントの認証監査

旧 `login.osm_connections` は個人OSM連携時代の監査・移行確認用として読み取り対象に残しますが、現在の送信・ログインには使用しません。

OAuthトークン、秘密鍵、Cookie、パスワードは監査履歴へ保存しません。

## 6. PROモード

- OSM公開対象は点字ブロック、JIS適合点字ブロック、JIS非適合点字ブロックです。
- OSM側では標準タグ `tactile_paving=yes` または道路左右タグを使用します。
- 柵、塀、グレーチング、その他の歩行支援情報、ひとことメモはStepBy DBだけへ保存し、OSMへ送りません。
- 地図表示は、一般OSM点字ブロックが青、StepBy由来が緑、PRO非公開記録が赤です。
- PROモード中は地図の赤枠と共通デザインのPROバッジを表示します。

## 7. 現在のシステム構成

### UI0

- フロント: GitHub Pages
- URL: `https://kumakero-otama.github.io/StepBy/UI0/map/Index.html`
- 通常フィッティング: ブラウザ版
- 保存・取消し: IndexedDB永続キュー

### Google Cloud

- Project: `stepby-cloud-dev-202608`
- VM: `stepby-dev-1`
- Region/Zone: Oregon `us-west1-b`
- VM: Compute Engine e2-micro、Ubuntu 24.04、30GB Standard Persistent Disk
- API: Node.js、`127.0.0.1:3100`
- HTTPS: Caddy、`https://stepby-api-8-229-191-182.sslip.io`
- DB: PostgreSQL 16 + PostGIS、localhost限定
- 秘密情報: Secret Manager（有効Versionは1つ）
- バックアップ: Cloud Storage、日次、30日保持
- 監視: Cloud Monitoringと軽量な定期観測

### 旧ローカル環境

- 正式UI0の公開経路には使用しません。旧コードと旧Valhallaは切戻し・比較資料として扱い、正式版の通常処理からは切り離しています。
- Tailscale経路はタスクリストなどの運用資料確認用であり、正式UI0のAPI経路ではありません。

## 8. 確認済みの実績

- 本番DB全328記録を読み取り専用で再検証しました。
- 比較可能107件のブラウザ版とValhalla版の位置差中央値は0.12m、90%点は2.18mでした。
- Way集合完全一致は98件、ブラウザ経路連続は106件でした。
- OSM開発環境でWay分割、タグ追加、取消し、冪等性、監査、試験地物削除を確認しました。
- 本番OSMへの初回実記録:
  - StepBy record: `4caab71a-13fa-4f25-a134-adba05ef684d`
  - 送信changeset: `187377001`
  - 元Way: `196594575` Version 4 → 5
  - 点字ブロック区間Way: `1549284663`
  - 残りの分割Way: `1549284664`
  - 取消changeset: `187379145`
  - OSM取消しとStepBy側の非表示化を確認済み
- StepBy専用OSMアカウントによる実記録:
  - StepBy record: `6812530d-c32a-405e-b092-9e4417c5376c`（内部記録者 `otama`）
  - 送信changeset: `187585080`
  - 現在Way: `1550317435` Version 3を基準に分割
  - 点字ブロック区間Way: `1550335908`
  - 公開タグ: `sidewalk:left:tactile_paving=yes`
  - 同時選択された非公開タグ「柵」はPostgreSQLだけに保持

## 9. はっきりしている問題・注意点

### 対応済みだが注意が必要

- 取消し後もStepBy保存線が残る問題: 修正済み。取消成功時に通常表示を無効化し、両レイヤーを再読込します。
- 緑線のタップ位置がずれて感じられる問題: 重複する2本の透明判定が原因でした。OSM送信済み記録はOSM線側の48px判定だけを使うよう修正済みです。
- Changesetコメントの「OSM未送信」: 今後は削除済み。過去changesetだけ変更不能です。
- 削除済みWayを30分キャッシュから参照して `osm_http_410` になった問題: 修正済み。保存直前にブラウザ・API双方のキャッシュを回避して最新Wayを取得します。

### 未完了・要検証

- 実端末での長距離移動、1km圏を越えた道路網追加取得、通信断、バックグラウンド復帰、電池消費の現地試験。
- 実端末で、複数Way、道路左右、独立歩道の少数実地確認。
- OSMコミュニティへの初回相談は実施済み。対象範囲やアルゴリズムを拡大するときは再相談します。
- 既存276経路の候補ごとの品質確認と、コミュニティ確認後の少量移行。

### 2026-08-17に追加確認・修正したこと

- フロント9試験、バックエンド9試験に合格。
- 既存の同等点字ブロックタグがあるWayでは、不要な分割・changesetを作らず正常完了するガードを追加。
- 第三者編集でVersionが変わった場合、changeset作成・uploadより前に停止する試験に合格。
- PROモードのグレーチング3件がクラウドDBだけに保存され、OSM変更案・changesetが作られないことを確認。
- 現行DBを読み取り専用で棚卸し。328記録、raw 7,344点、経路276件、完全重複経路0件。rawなし6件、経路なし52件、孤立raw/matched各3点、旧accuracy全件未保存。
- 既存データ移行監査とOSMコミュニティ相談文案を作成。
- 個人OSM OAuthを廃止し、StepBy専用OSMアカウントへ一本化。利用者別の記録者情報はPostgreSQLだけで保持。
- 通常・PRO・ゲストを含むOSM公開対象判定をサーバーで再検証し、非公開タグとメモは記録者本人以外へ返さない。
- 本番Changeset `187585080` で、点字ブロックだけが公開され「柵」がOSMへ出ないことを確認。

## 10. 次に行う順番

1. 1km圏を越える移動、通信断、画面ロック、長時間記録を実端末で確認する。
2. 判明した不具合を直し、回帰テストを追加する。
3. 限定利用者で運用し、誤送信率・競合率・処理時間・取消し件数を測定する。
4. 管理者審査キューの誤承認率・却下率・処理時間を測定する。
5. 既存276経路を候補ごとに確認し、追加のコミュニティ確認と個別許可後に少量ずつ扱う。

## 11. 絶対ルール

- 一般利用者の「保存」はStepBy DBへの保存と管理者審査待ち登録までです。OSM送信は管理者が対象記録を承認した場合だけ実行します。
- ゲスト記録はStepBy DBだけに保存し、OSM送信対象にしません。
- 本人の緑線に対する「削除」の確認は、その記録1件だけの取消し許可です。
- 管理者API、既存データ一括処理、任意のOSM編集は、操作ごとの明示許可が必要です。
- OSM送信前に追記型監査履歴を保存できなければ送信しません。
- 同じ記録を二重送信しません。
- 取消しでも履歴は消さず、新しいchangesetと監査イベントを追加します。
- Version競合や第三者編集がある場合、自動上書きしません。
- 開発環境は現行DBへ接続しません。

## 12. 主要リンク

- [バックエンド再現手順](REPRODUCTION.md)
- [PostgreSQL再現用スキーマ](../database/schema.sql)
- [文書索引](README.md)
- [タスクリスト](https://barrierfree-map.tail5de5e1.ts.net/project-plan-preview.html)
- [システム構成図](https://barrierfree-map.tail5de5e1.ts.net/system-architecture.svg)
- [API一覧](https://barrierfree-map.tail5de5e1.ts.net/api-catalog.html)
- [クラウド移行案](https://barrierfree-map.tail5de5e1.ts.net/cloud-migration-options.html)
- [既存データ移行監査](https://barrierfree-map.tail5de5e1.ts.net/existing-data-migration-audit.md)
- [OSMコミュニティ相談文案](https://barrierfree-map.tail5de5e1.ts.net/osm-community-consultation-draft.md)
- [Valhalla・ブラウザ版検証報告](https://barrierfree-map.tail5de5e1.ts.net/valhalla-browser-fitting-report.html)
- [開発DB管理画面](https://barrierfree-map.tail5de5e1.ts.net/dev-api/admin/database.html)
- [UI0](https://kumakero-otama.github.io/StepBy/UI0/map/Index.html)
- [UI0プロフィール](https://kumakero-otama.github.io/StepBy/UI0/profile/Index.html)
- [クラウドAPI health](https://stepby-api-8-229-191-182.sslip.io/api/health)
- [OpenStreetMap本番](https://www.openstreetmap.org/)
- [初回本番changeset 187377001](https://www.openstreetmap.org/changeset/187377001)
- [初回本番Way 1549284663の履歴](https://www.openstreetmap.org/way/1549284663/history)
- [初回本番取消changeset 187379145](https://www.openstreetmap.org/changeset/187379145)
- [StepBy専用アカウントChangeset 187585080](https://www.openstreetmap.org/changeset/187585080)
- [StepBy専用アカウントで公開したWay 1550335908](https://www.openstreetmap.org/way/1550335908)
- [StepByフロントエンドGitHub](https://github.com/kumakero-otama/StepBy)
- [StepByバックエンドGitHub](https://github.com/kumakero-otama/barrierfree-map)

## 13. 文書の更新ルール

- フロント、バックエンド、ポート、プロセス、トンネル、DB、外部サービス、認証、OSM送信先、主要API、確定仕様、既知の問題が変わった場合、この文書も同じ作業で更新します。
- システム構成が変わった場合は `system-architecture.svg` とタスクリストも同時に更新します。
- 秘密鍵、OAuthアクセストークン、Cookie、パスワード、DB認証情報はこの文書に記載しません。
