# Valhalla 導入 & 4都府県タイル生成手順書

本ドキュメントは、**Valhalla を Docker で導入し、岡山・大阪・愛知・東京の4都府県の OSM データから pedestrian 対応 Valhalla タイルを生成するまで**の具体手順をまとめたものです。

対象環境:
- Ubuntu / Linux
- RAM: 8GB
- SSD: 500GB クラス
- Docker / docker compose 利用

---

## 全体構成

```
~/gis/valhalla/
 ├─ docker-compose.yml
 ├─ config/
 │   └─ valhalla.json
 ├─ osm/
 │   ├─ okayama-latest.osm.pbf
 │   ├─ osaka-latest.osm.pbf
 │   ├─ aichi-latest.osm.pbf
 │   └─ tokyo-latest.osm.pbf
 └─ tiles/
```

---

## STEP 1: 作業ディレクトリ作成

```bash
mkdir -p ~/gis/valhalla/{osm,tiles,config}
cd ~/gis/valhalla
```

---

## STEP 2: Valhalla 設定ファイル作成

```bash
nano config/valhalla.json（valhallaの設定ファイル）
```

```json
{
  "mjolnir": {
    "tile_dir": "/data/tiles",
    "concurrency": 2
  },
  "service_limits": {
    "auto": { "max_distance": 5000000 },
    "pedestrian": { "max_distance": 200000 }
  },
  "costing_options": {
    "pedestrian": {
      "use_ferry": 0.5,
      "use_living_streets": 1.0,
      "walkway_factor": 1.0,
      "sidewalk_factor": 1.0
    }
  }
}
```

---

## STEP 3: docker-compose.yml 作成

```bash
nano docker-compose.yml（Dockerを実行するときの設定ファイル）
```

```yaml
services:
  valhalla:
    image: ghcr.io/valhalla/valhalla:latest
    container_name: valhalla
    volumes:
      - ./osm:/data/osm
      - ./tiles:/data/tiles
      - ./config/valhalla.json:/etc/valhalla/valhalla.json
    ports:
      - "8002:8002"
    command: valhalla_service /etc/valhalla/valhalla.json
```

---

## STEP 4: OSM PBF データ取得

```bash
cd ~/gis/valhalla/osm

wget https://download.geofabrik.de/asia/japan/chugoku-latest.osm.pbf
wget https://download.geofabrik.de/asia/japan/kansai/osaka-latest.osm.pbf
wget https://download.geofabrik.de/asia/japan/chubu/aichi-latest.osm.pbf
wget https://download.geofabrik.de/asia/japan/kanto/tokyo-latest.osm.pbf

```


---

## STEP 5: Valhalla タイル生成（県ごと）

※ **必ず1県ずつ実行すること**

### 岡山県

```bash
docker exec -it valhalla   valhalla_build_tiles   -c /etc/valhalla/valhalla.json   /data/osm/okayama-latest.osm.pbf
```

### 大阪府

```bash
docker exec -it valhalla   valhalla_build_tiles   -c /etc/valhalla/valhalla.json   /data/osm/osaka-latest.osm.pbf
```

### 愛知県

```bash
docker exec -it valhalla   valhalla_build_tiles   -c /etc/valhalla/valhalla.json   /data/osm/aichi-latest.osm.pbf
```

### 東京都（最も重い）

```bash
docker exec -it valhalla   valhalla_build_tiles   -c /etc/valhalla/valhalla.json   /data/osm/tokyo-latest.osm.pbf
```

---

## STEP 6: Valhalla 起動

```bash
cd ~/gis/valhalla
docker compose up -d
```

確認:

```bash
docker ps
```

---

## STEP 7: タイル生成確認

```bash
du -sh tiles
```

目安: **6〜10GB**

---

## STEP 8: Valhalla 動作確認

```bash
curl http://localhost:8002/status
```

JSON が返れば成功。

---

## ここまででできること

- raw GPS 座標を Valhalla Map Matching API に送信可能
- edge_id / shape を取得可能
- pedestrian 対応のルーティング・マッチング基盤完成

---

## 次のステップ（参考）

- Map Matching API 実例
- edge / shape の解釈
- PostGIS への session way 保存
- HTML（Leaflet等）でのレイヤ重畳表示
