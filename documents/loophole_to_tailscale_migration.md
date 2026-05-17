# loophole → Tailscale Funnel 移行計画

## 背景

現状、Barrierfree Map のバックエンドAPIは loophole トンネル経由で
`https://barrierfree-map.loophole.site` として公開されている。
GitHub Pages 上のフロントエンド ([kumakero-otama/StepBy](https://github.com/kumakero-otama/StepBy))
はこのURLを `API_BASE_URL` としてハードコードしている。

### 問題

loophole サービスが2026年5月時点で不安定となり、外部からのAPIアクセスが
タイムアウトする状態が継続している。

- ローカル `http://localhost:3000` は正常
- 外部 `https://barrierfree-map.loophole.site` は TCP 接続/TLS ハンドシェイクが完了しない
- loophole CLI のログは `Initializing secure tunnel... Success!` で停止するが、
  実際のリッスンが確立していない
- `logs/barrierfree-map-loophole-error.log` に
  `Listening on remote endpoint for HTTPS failed` + `Tunnel startup error error=EOF` が
  毎時 `XX:20` 前後で連発
- リトライ12回試行も全て失敗
- 既知の GitHub Issue（#189 / #290 / #294）と一致
- loophole CLI 最新版は `1.0.0-beta.15`（2022年4月、約4年放置）で
  事実上メンテナンス停止

## 移行先: Tailscale Funnel

複数のトンネルサービスを比較した結果、本構成での候補は次のとおり：

| サービス | 評価 | 主な理由 |
|---|---|---|
| **Cloudflare Tunnel** | ◎ | 無料・安定・固定URL・大規模配信に耐える |
| **Tailscale Funnel** | ○ | 無料・固定URL・1コマンド導入。`.ts.net` 固定の制約あり |
| ngrok | △ | 無料枠はURL動的、固定URL有料($8/月〜) |
| Pinggy | △ | 無料枠は60分セッション切れ |
| localtunnel | △ | コミュニティ運営、SLAなし |
| frp + VPS | ○ | 自分管理で柔軟、ただしVPS費用が別途必要 |

今回は **Tailscale Funnel** を採用予定。理由：

- 無料・即導入可能
- URLが固定（`<machine>.<tailnet>.ts.net`）
- TLSはFunnelリレーで自動終端
- 認証ユーザー数の上限「6ユーザー」は tailnet 管理者の数であり、
  Funnel 経由でAPIを叩く一般PWA利用者はカウント対象外
- 既存の CORS 設定（`*.github.io` 許可済）は変更不要

## 構成の変化

### Before (loophole)

```
[PWAブラウザ] ──HTTPS──▶ [loophole.cloud リレー] ──SSH over HTTPS──▶ [自宅サーバ:3000]
                          barrierfree-map.loophole.site
```

### After (Tailscale Funnel)

```
[PWAブラウザ] ──HTTPS──▶ [Tailscale Funnel リレー] ──WireGuard──▶ [tailscaled] ──loopback──▶ [自宅サーバ:3000]
                          <machine>.<tailnet>.ts.net
```

詳細な構成図とシーケンスは [`doc/tailscale_network.html`](../doc/tailscale_network.html) を参照。

## 変更箇所

| ファイル / 場所 | 変更内容 |
|---|---|
| `StepBy/UI0/config.js` | `API_BASE_URL` を新URLに書き換え |
| `StepBy/UI0/auth/token_client.js` | `DEFAULT_API_BASE_URL` を新URLに書き換え |
| `barrierfree-map/ecosystem.config.js` | `barrierfree-map-loophole` エントリを削除（または無効化） |
| サーバ環境 | Tailscale をインストール → `tailscale up` → `tailscale funnel --bg 3000` |
| (任意) `CORS_ALLOWED_ORIGINS` | 通常は変更不要（既存の `*.github.io` 正規表現で吸収済） |

## 作業手順（予定）

### 1. Tailscale のインストールとログイン
1. サーバに Tailscale をインストール (`apt install tailscale` など)
2. `sudo tailscale up` を実行すると認証URLが表示される
3. スマホかPCのブラウザでそのURLを開き Google/GitHub 等でログイン
4. 同じアカウントを管理者として固定（後で auth key を発行することも可能）

### 2. マシン名整理（任意）
- `sudo tailscale set --hostname=barrierfree-map` でURLを
  `barrierfree-map.<tailnet>.ts.net` の形に整える

### 3. Funnel 有効化
- `sudo tailscale funnel --bg 3000` で localhost:3000 を公開
- 表示されるURLを控える

### 4. 動作確認（ローカル）
- 外部からの疎通: `curl https://<machine>.<tailnet>.ts.net/api/config` で 200 を確認
- 既存ルートが loophole 想定で動いているか:
  - `/api/config`, `/api/stats`, `/auth/me` などをスポット確認

### 5. フロントエンドの URL 切替
- `StepBy/UI0/config.js` と `StepBy/UI0/auth/token_client.js` の
  `API_BASE_URL` を新URLに変更してコミット → push
- GitHub Pages 再ビルドの完了を待つ
- 切替後、PWA から実機で動作確認

### 6. 認証関連の検証（重要）
クロスサイトの認証経路を実機で確認する：

- **Cookie 経由**: `Set-Cookie` に `SameSite=None; Secure` が付与されているか確認。
  Safari / Brave / 強化Firefox では third-party Cookie が遮断される場合があるため、
  動作環境ごとに検証する。
- **Bearer 経由**: Cookie が遮断された環境でも
  `Authorization: Bearer <token>` で動作することを確認する。
  ([server/auth_token.js](../server/auth_token.js) / 
  [auth/token_client.js](../../StepBy/UI0/auth/token_client.js))

### 7. loophole 撤去
- `pm2 stop barrierfree-map-loophole && pm2 delete barrierfree-map-loophole`
- `ecosystem.config.js` から該当エントリを削除
- `pm2 save`

### 8. ドキュメント更新
- README / DEVELOPMENT.md にトンネル方式の変更を追記
- [doc/tailscale_network.html](../doc/tailscale_network.html) は反映済み

## 留意点

- **帯域**: Tailscale Personal プランの Funnel には非公開のソフトリミットがある。
  通常運用では問題にならないが、トラフィックが急増した場合は Cloudflare Tunnel への
  再移行を検討する。
- **ポート制限**: Funnel は `443 / 8443 / 10000` のみ対応。本アプリは 443 で十分。
- **Tailscale 障害時**: localhost:3000 は変わらず動くので SSH 経由でローカル検証可能。
  フロントエンドが `API_BASE_URL` 1箇所で切替できる構成を維持しておく。
- **商用利用**: "Personal" プランの規約上、明確な商用禁止条文はないが、
  大規模/業務用途では Cloudflare Tunnel または有料プランへの移行を検討。

## 関連ドキュメント

- [doc/tailscale_network.html](../doc/tailscale_network.html) — Tailscale Funnel
  採用時のネットワーク構成図（SVG入りHTML）
- [documents/API_list.md](API_list.md) — APIエンドポイント一覧（URLは変更不要）
- [server.js](../server.js) — CORS実装箇所（`isCorsOriginAllowed`）

## 現在のステータス

- 移行計画策定済み
- 実作業（Tailscale インストール以降）は未着手
- ユーザー判断待ち
