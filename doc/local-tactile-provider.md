# 岡山市 OSM点字ブロック・ローカル読取provider

## 目的

公開Overpass APIが混雑・停止している間も、岡山市内のOSM点字ブロック表示を継続するための限定的な読取providerです。完全なOverpass互換サーバーではなく、StepByが使用するz15点字ブロックタイルだけをPostgreSQLから返します。

## 読取順

1. `osmcache.tactile_tiles`（公開Overpassから得た最新の動的キャッシュ）
2. `osmcache.local_tactile_tiles`（岡山市の事前抽出snapshot。空区画を含む）
3. 公開Overpass API（上記のどちらにもない区画）

APIは従来どおり `GET /api/osm-tactile-tiles` を使用するため、UI0の接続先変更は不要です。

## データと容量

- 原典: Geofabrik `chugoku-latest.osm.pbf`（OpenStreetMap contributors / ODbL 1.0）
- 抽出範囲: 岡山市行政境界
- 表示対象: `tactile_paving=yes|both|contrasted` のNode・Way
- 2026-10-25 snapshot: 固有地物309件、z15タイル981件（空区画946件を含む）、seed JSON約233KB

空区画も保存し、点字ブロックが存在しない区画を公開Overpassへ繰り返し問い合わせないようにします。

## 安全な投入

### seedの再生成

再生成用スクリプトはPython 3、`osmium`（pyosmium）、`shapely`を使用します。巨大なPBF、行政境界、生成seedはGitへコミットしません。

```bash
python3 -m venv .venv
.venv/bin/pip install osmium shapely
curl -L --fail -o chugoku-latest.osm.pbf \
  https://download.geofabrik.de/asia/japan/chugoku-latest.osm.pbf
curl -L --fail --get 'https://nominatim.openstreetmap.org/search' \
  --data-urlencode 'q=岡山市, 岡山県, 日本' \
  --data 'format=geojson' --data 'polygon_geojson=1' --data 'limit=1' \
  -H 'User-Agent: StepBy-local-seed/1.0 (stepbybarrierfree@gmail.com)' \
  -o okayama-city-boundary.geojson
.venv/bin/python scripts/build_local_tactile_seed.py \
  --pbf chugoku-latest.osm.pbf \
  --boundary okayama-city-boundary.geojson \
  --output okayama-tactile-z15-seed.json \
  --region 岡山市 \
  --source-url https://download.geofabrik.de/asia/japan/chugoku-latest.osm.pbf
```

配布元の`.md5`とダウンロードファイルのMD5を照合してから生成します。Nominatimへの境界取得は1回だけ行い、連続実行しません。生成後は次の検証専用コマンドで件数を確認します。

投入スクリプトは既定で検証だけを行います。

```bash
node scripts/import_local_tactile_tiles.js /path/to/okayama-tactile-z15-seed.json
```

内容・件数を確認した後だけ、`--apply`で1トランザクションの差替えを実行します。

```bash
node scripts/import_local_tactile_tiles.js /path/to/okayama-tactile-z15-seed.json --apply
```

不完全な入力、重複タイル、5000件超過、10MB超過は拒否します。投入に失敗した場合はロールバックされ、直前snapshotを保持します。

## OSM更新との整合性

StepByがOSM公開・取消しに成功したタイルは、動的キャッシュとローカルsnapshotの両方から削除します。その区画は最新OSMデータを公開Overpassから再取得するまでsnapshotへ戻りません。OSMへの書込み監査・権限制御には影響しません。

## 更新

初回は手動snapshotです。将来の定期更新では、中国地方PBFを一時取得して岡山市内の対象タグだけを再抽出し、検証後に同じスクリプトで差し替えます。元PBFをクラウドへ常置しません。
