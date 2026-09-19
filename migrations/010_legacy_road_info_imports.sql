-- 旧StepByから道情報を安全に再移行するための対応表。
-- 元IDと新IDの組を一意に保持し、同じ移行を再実行しても重複登録させない。
CREATE TABLE IF NOT EXISTS roadinfo.legacy_point_imports (
    source_system text NOT NULL,
    source_point_id bigint NOT NULL,
    point_id bigint NOT NULL REFERENCES roadinfo.road_info_point(id),
    source_status text NOT NULL,
    requires_review boolean DEFAULT false NOT NULL,
    review_reason text,
    imported_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (source_system, source_point_id),
    UNIQUE (point_id)
);

ALTER TABLE roadinfo.legacy_point_imports
    ADD COLUMN IF NOT EXISTS requires_review boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS review_reason text;

COMMENT ON TABLE roadinfo.legacy_point_imports IS
    '旧StepByの道情報IDと現行DBのIDを対応付ける追記型の移行記録';

GRANT SELECT, INSERT, UPDATE, DELETE ON roadinfo.legacy_point_imports TO stepby_dev;
