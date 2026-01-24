-- セッションテーブルにsession_uuidカラムを追加するマイグレーション
-- 既存のsessionsテーブルがある場合の対応

-- 1. 既にsessionsテーブルが存在する場合、session_uuidカラムを追加
ALTER TABLE `sessions` 
ADD COLUMN `session_uuid` varchar(36) NOT NULL AFTER `id`,
ADD UNIQUE KEY `uk_sessions_session_uuid` (`session_uuid`);

-- 2. テーブルが存在しない場合は新規作成（上記のALTERが失敗した場合に実行）
-- CREATE TABLE IF NOT EXISTS `sessions` (
--   `id` bigint(20) NOT NULL AUTO_INCREMENT,
--   `session_uuid` varchar(36) NOT NULL,
--   `user_id` varchar(64) NOT NULL,
--   `started_at` datetime NOT NULL DEFAULT current_timestamp(),
--   `ended_at` datetime DEFAULT NULL,
--   `note` varchar(255) DEFAULT NULL,
--   PRIMARY KEY (`id`),
--   UNIQUE KEY `uk_sessions_session_uuid` (`session_uuid`),
--   KEY `idx_sessions_user_id` (`user_id`)
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- CREATE TABLE IF NOT EXISTS `session_points` (
--   `id` bigint(20) NOT NULL AUTO_INCREMENT,
--   `session_id` bigint(20) NOT NULL,
--   `seq` int(11) NOT NULL,
--   `lat` decimal(9,6) NOT NULL,
--   `lng` decimal(9,6) NOT NULL,
--   `created_at` datetime NOT NULL DEFAULT current_timestamp(),
--   PRIMARY KEY (`id`),
--   KEY `idx_session_points_session_id` (`session_id`),
--   KEY `idx_session_points_session_seq` (`session_id`,`seq`),
--   CONSTRAINT `fk_session_points_session` FOREIGN KEY (`session_id`) REFERENCES `sessions` (`id`) ON DELETE CASCADE
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
