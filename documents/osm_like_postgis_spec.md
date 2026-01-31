# OSM互換・自前セッションGIS仕様書（軽量版）

## 目的
本仕様は、実際に歩行して取得したGPSデータ（raw座標）を  
**OSM互換の構造（nodes / ways / way_nodes）**で PostGIS に保存し、  
HTML地図アプリ上で **公式OSMレイヤと重畳表示** することを目的とする。

Overpass や OSMフルクローンは採用せず、  
**軽量・再解釈可能・将来OSMへ還元可能** な構成とする。

---

## 全体アーキテクチャ

```
[ HTML / Map ]
      │
      ├─ 公式OSM（タイル or 自前OSM PostGIS）
      │
      └─ 自前API
            ↓
        PostGIS
        ├─ nodes
        ├─ ways
        └─ way_nodes
```

---

## 設計方針

- 記録の「正」は raw GPS
- フィッティング結果は補助情報
- 履歴管理・changeset・relation は持たない
- 構造のみ OSM互換
- 検索・表示は **SQL + PostGIS**

---

## データモデル

### nodes テーブル

| カラム名 | 型 | 説明 |
|---|---|---|
| id | UUID (PK) | 自前ノードID |
| geom | geometry(Point, 4326) | 座標 |
| session_id | UUID | 記録セッション |
| role | text | start / raw / end |
| created_at | timestamptz | 作成時刻 |

```sql
CREATE TABLE nodes (
  id UUID PRIMARY KEY,
  geom geometry(Point, 4326) NOT NULL,
  session_id UUID NOT NULL,
  role TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_nodes_geom ON nodes USING GIST (geom);
```

---

### ways テーブル

| カラム名 | 型 | 説明 |
|---|---|---|
| id | UUID (PK) | 自前way ID |
| session_id | UUID | 記録セッション |
| kind | text | session / tactile |
| created_at | timestamptz | 作成時刻 |

```sql
CREATE TABLE ways (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL,
  kind TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

### way_nodes テーブル

| カラム名 | 型 | 説明 |
|---|---|---|
| way_id | UUID | ways.id |
| node_id | UUID | nodes.id |
| seq | integer | 並び順 |

```sql
CREATE TABLE way_nodes (
  way_id UUID REFERENCES ways(id),
  node_id UUID REFERENCES nodes(id),
  seq INTEGER NOT NULL,
  PRIMARY KEY (way_id, seq)
);
```

---

## geometry 組み立て（VIEW）

```sql
CREATE VIEW way_lines AS
SELECT
  w.id AS way_id,
  ST_MakeLine(n.geom ORDER BY wn.seq) AS geom,
  w.session_id,
  w.kind
FROM ways w
JOIN way_nodes wn ON w.id = wn.way_id
JOIN nodes n ON wn.node_id = n.id
GROUP BY w.id;
```

---

## API設計（例）

### bbox検索

```
GET /ways?bbox=minLon,minLat,maxLon,maxLat
```

SQL例：

```sql
SELECT way_id, ST_AsGeoJSON(geom)
FROM way_lines
WHERE geom && ST_MakeEnvelope(lon1, lat1, lon2, lat2, 4326);
```

---

## 表示レイヤ構成（HTML）

1. ベースマップ（OSM / Mapbox）
2. 公式OSM点字ブロック（任意）
3. 自前セッションway（本仕様）
4. （将来）確定 tactile_layer

---

## 将来拡張（非必須）

- tactile_layer（確定データ）
- coverage / confidence 算出
- OSM差分エクスポート
- relation 対応（必要時）

---

## 採用しないもの

- Overpass API
- OSMフルクローン
- version / changeset / history
- 全世界OSMデータ保持

---

## まとめ

- **OSM互換構造 + PostGIS**
- **軽量・再利用可能**
- **表示と記録を分離**
- **将来OSMへ還元可能**

この仕様は「まず積める」「後で壊れない」ことを最優先とする。
