# StepBy既存点字ブロックデータ移行監査

更新日: 2026-08-25

## 結論

現行PostgreSQLは読み取り専用トランザクションで調査・抽出しました。対象期間の328記録はクラウド審査キューへ取込済みで、元DBへの書込みとOSM送信は行っていません。自動分類は確認待ち218件、保留106件、ゲスト非公開4件です。管理者が航空写真とOSMを並べて1件ずつ判断し、承認記録だけを現在OSMで再処理して扱います。

## 集計結果

|項目|件数・結果|
|---|---:|
|記録セッション|328|
|有効状態の記録|250|
|GPS raw点|7,344|
|Valhalla matched点|7,344|
|保存済み経路|276|
|rawを持つ記録|322|
|経路を持つ記録|276|
|rawがない記録|6|
|経路がない記録|52|
|同一形状の重複経路|0|
|孤立raw点|3|
|孤立matched点|3|
|孤立経路|0|
|accuracyが保存されたraw点|0|
|記録期間|2026-02-10〜2026-08-10|

## 移行候補の判定順

1. `session_paths` がある276件だけを一次候補にします。
2. 無効化済み記録、極端に短い経路、自己交差、道路網から外れる経路を除外します。
3. 現在のOSMを取得し、既存の点字ブロックタグと重複する候補を除外します。
4. accuracyは旧DBに存在しないため、rawと経路形状、記録日時、現地知識を使って人が確認します。
5. Way IDは現在のOSMへ再フィッティングして確定し、旧Valhallaのedge IDをそのままOSM IDとして使いません。
6. 公開候補、要確認、除外の3区分に分けます。

## 送信前の必須条件

- OSM WikiのImport GuidelinesおよびAutomated Edits code of conductに沿った計画文書を公開する。
- 日本または対象地域のOSMコミュニティへ相談し、懸念を解消する。
- 既存OSMとの重複・競合を候補ごとに確認する。
- 小さいchangesetに分け、変更前後・ID・Version・changeset IDを追記型監査履歴へ保存する。
- 本番OSMへの各送信は、その操作について管理者から明示許可を得る。
- 第三者編集によるVersion不一致時は上書きせず停止する。

## 参照

- [OSM Import Guidelines](https://wiki.openstreetmap.org/wiki/Import/Guidelines)
- [Automated Edits code of conduct](https://wiki.openstreetmap.org/wiki/Automated_Edits/Code_of_Conduct)
