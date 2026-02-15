# table_sql.md
PostGreのテーブルを作るSQLコマンドのまとめ

## roadinfo.road_info_point
1レコードが1つの道情報のポイント
```SQL
CREATE TABLE roadinfo.road_info_point (
  id BIGSERIAL PRIMARY KEY,
  geom GEOGRAPHY(POINT, 4326) NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'hidden', 'deleted', 'needs_review')),
  created_by BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX road_info_point_geom_idx
  ON roadinfo.road_info_point
  USING GIST (geom);
CREATE INDEX road_info_point_status_idx
  ON roadinfo.road_info_point (status);
```

## roadinfo.road_info_tag
1レコードが1つのタグ
post_tags.yamlの代わりに、このテーブルを使う
```SQL
CREATE TABLE roadinfo.road_info_tag (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label_ja TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true, 
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX road_info_tag_sort_idx
  ON roadinfo.road_info_tag (sort_order);
```

## roadinfo.road_info_point_tag
1レコードが1つのタグ。道情報のポイントとそこについているタグを1対多対応させる
```SQL
CREATE TABLE roadinfo.road_info_point_tag (
  point_id BIGINT NOT NULL
    REFERENCES roadinfo.road_info_point(id)
    ON DELETE CASCADE,
  tag_id BIGINT NOT NULL
    REFERENCES roadinfo.road_info_tag(id)
    ON DELETE CASCADE,
  PRIMARY KEY (point_id, tag_id)
);
CREATE INDEX road_info_point_tag_tag_idx
  ON roadinfo.road_info_point_tag (tag_id);
```

## roadinfo.road_info_note
1レコードが1つの説明文
```SQL
CREATE TABLE roadinfo.road_info_note (
  id BIGSERIAL PRIMARY KEY,
  point_id BIGINT NOT NULL
    REFERENCES roadinfo.road_info_point(id)
    ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_by BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX road_info_note_point_idx
  ON roadinfo.road_info_note (point_id, created_at DESC);
```

## roadinfo.road_info_media
1レコードが1つの写真。説明文と紐づけしている
```SQL
CREATE TABLE roadinfo.road_info_media (
  id BIGSERIAL PRIMARY KEY,
  note_id BIGINT NOT NULL
    REFERENCES roadinfo.road_info_note(id)
    ON DELETE CASCADE,
  media_type TEXT NOT NULL DEFAULT 'image',
  url TEXT NOT NULL,
  created_by BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX road_info_media_note_idx
  ON roadinfo.road_info_media (note_id);
```

## tactile.sessions
1レコードが1つのセッション。セッションを作った時刻やデバイスがわかる
```SQL
CREATE TABLE sessions (
  session_id UUID PRIMARY KEY,
  device_id UUID,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP
);
```

## tactile.gps_raw
1レコードが1つのraw座標。どのセッションに属するか、どの位置にあるかなどがわかる
```SQL
CREATE TABLE gps_raw (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(session_id),
  ts TIMESTAMP NOT NULL,
  geom GEOGRAPHY(POINT, 4326) NOT NULL,
  accuracy FLOAT
);
```

## tactile.gps_matched
1レコードが1つのフィッティング後の座標。どのセッションに属するか、どの位置にあるかなどがわかる
```SQL
CREATE TABLE gps_matched (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(session_id),
  ts TIMESTAMP NOT NULL,
  geom GEOGRAPHY(POINT, 4326) NOT NULL,
  edge_id BIGINT,
  confidence FLOAT
);
```

## tactile.session_paths
1レコードが1つのセッション。セッション全体でフィッティングしたときの記録用。座標などがわかる
```SQL
CREATE TABLE session_paths (
  session_id UUID PRIMARY KEY
    REFERENCES sessions(session_id),

  geom GEOGRAPHY(LINESTRING, 4326) NOT NULL,

  source TEXT NOT NULL,               -- 例: 'valhalla'
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
```

## tactile.session_path_edges
1レコードが1つのエッヂ。どのセッションに属するか、セッション内で何番目かなどわかる
```SQL
CREATE TABLE session_path_edges (
  session_id UUID
    REFERENCES sessions(session_id),

  seq INTEGER NOT NULL,
  edge_id BIGINT NOT NULL,

  PRIMARY KEY (session_id, seq)
);
```