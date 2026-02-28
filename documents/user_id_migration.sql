-- user_id 統一マイグレーション
-- 目的:
-- 1) login.users.user_id を BIGINT 系へ統一
-- 2) tactile.sessions の device_id を廃止し user_id へ移行
-- 3) roadinfo.* の created_by を login.users(user_id) に紐づけ可能にする

BEGIN;

-- 0) 前提スキーマ
CREATE SCHEMA IF NOT EXISTS login;
CREATE SCHEMA IF NOT EXISTS tactile;
CREATE SCHEMA IF NOT EXISTS roadinfo;

-- 1) login 系: user_id 型を BIGINT に統一
ALTER TABLE IF EXISTS login.user_auth_providers
  DROP CONSTRAINT IF EXISTS user_auth_providers_user_id_fkey;
ALTER TABLE IF EXISTS login.user_sessions
  DROP CONSTRAINT IF EXISTS user_sessions_user_id_fkey;

ALTER TABLE IF EXISTS login.users
  ALTER COLUMN user_id TYPE BIGINT;
ALTER TABLE IF EXISTS login.user_auth_providers
  ALTER COLUMN user_id TYPE BIGINT;
ALTER TABLE IF EXISTS login.user_sessions
  ALTER COLUMN user_id TYPE BIGINT;

ALTER TABLE IF EXISTS login.user_auth_providers
  DROP CONSTRAINT IF EXISTS user_auth_providers_user_id_fkey;
ALTER TABLE IF EXISTS login.user_sessions
  DROP CONSTRAINT IF EXISTS user_sessions_user_id_fkey;

ALTER TABLE IF EXISTS login.user_auth_providers
  ADD CONSTRAINT user_auth_providers_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES login.users(user_id) ON DELETE CASCADE;
ALTER TABLE IF EXISTS login.user_sessions
  ADD CONSTRAINT user_sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES login.users(user_id) ON DELETE CASCADE;

-- 2) tactile.sessions: device_id を廃止し user_id で管理
ALTER TABLE IF EXISTS tactile.sessions
  ADD COLUMN IF NOT EXISTS user_id BIGINT;

-- 既存データに user_id がない場合は手動で補完してください。
-- 例:
-- UPDATE tactile.sessions SET user_id = 4 WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_tactile_sessions_user_id
  ON tactile.sessions (user_id);

ALTER TABLE IF EXISTS tactile.sessions
  DROP CONSTRAINT IF EXISTS sessions_user_id_fkey;
ALTER TABLE IF EXISTS tactile.sessions
  ADD CONSTRAINT sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES login.users(user_id);

ALTER TABLE IF EXISTS tactile.sessions
  DROP COLUMN IF EXISTS device_id;

-- 3) roadinfo: created_by を user_id に参照させる（NULL は許容）
ALTER TABLE IF EXISTS roadinfo.road_info_point
  DROP CONSTRAINT IF EXISTS road_info_point_created_by_fkey;
ALTER TABLE IF EXISTS roadinfo.road_info_note
  DROP CONSTRAINT IF EXISTS road_info_note_created_by_fkey;
ALTER TABLE IF EXISTS roadinfo.road_info_media
  DROP CONSTRAINT IF EXISTS road_info_media_created_by_fkey;

ALTER TABLE IF EXISTS roadinfo.road_info_point
  ADD CONSTRAINT road_info_point_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES login.users(user_id);
ALTER TABLE IF EXISTS roadinfo.road_info_note
  ADD CONSTRAINT road_info_note_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES login.users(user_id);
ALTER TABLE IF EXISTS roadinfo.road_info_media
  ADD CONSTRAINT road_info_media_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES login.users(user_id);

COMMIT;
