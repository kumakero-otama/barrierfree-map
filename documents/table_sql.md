# table_sql.md
PostGreのテーブルを作るSQLコマンドのまとめ

## sessions
1レコードが1つのセッション。セッションを作った時刻やデバイスがわかる
```SQL
CREATE TABLE sessions (
  session_id UUID PRIMARY KEY,
  device_id UUID,
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP
);
```

## gps_raw
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

## gps_matched
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

## session_paths
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

## session_path_edges
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