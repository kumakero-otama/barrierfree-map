CREATE SCHEMA IF NOT EXISTS login;

CREATE TABLE IF NOT EXISTS login.changelog_item_views (
  user_id BIGINT NOT NULL REFERENCES login.users(user_id) ON DELETE CASCADE,
  item_id VARCHAR(128) NOT NULL,
  changelog_version VARCHAR(32) NOT NULL,
  language VARCHAR(12) NOT NULL,
  item_text TEXT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  first_displayed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, item_id)
);

COMMENT ON TABLE login.changelog_item_views IS
  '利用者へ実際に表示したチェンジログ項目を、項目単位で保持する。';
