# road_info_detail ページ構成

このフォルダは道情報詳細ページです。  
地図上の道情報ピンから `pointId` 付きで遷移して表示します。

## ファイル一覧

### `Index.html`
- 詳細画面のDOM構造。
- 役割:
  - タグ表示領域
  - 投稿件数と投稿一覧領域
  - 最下部アクションボタン:
    - `自分もここに投稿する`（表示のみ、未実装）
    - `戻る`（地図へ戻る）
  - バージョン表示
- 読み込むファイル:
  - `road_info_detail.css`
  - `road_info_detail.js`
  - `/version.js`
  - `/pwa.js`

### `road_info_detail.css`
- 詳細画面専用スタイル。
- 主な対象:
  - 「タグ」「投稿」小見出し
  - タグの箇条書き表示
  - 投稿カード、本文、画像表示
  - 画面下部のボタン配置

### `road_info_detail.js`
- 詳細データ取得と描画ロジック。
- 主要処理:
  - URLクエリ `pointId` を取得
  - `/api/road-info?pointId=...` から詳細取得
  - タグ一覧・投稿一覧・画像をDOMに描画
  - 投稿日時フォーマット
  - アカウントアイコンとして `/assets/account_default.png` を使用
  - 戻るボタンで履歴戻り（履歴がなければ `/map/Index.html`）

