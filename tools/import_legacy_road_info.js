#!/usr/bin/env node
"use strict";

// 旧StepByの未削除データを、重複を防ぎながら現行DBへ移す。
const fs = require("fs");
const path = require("path");
const { createDbPool } = require("../server/db");

const SOURCE_SYSTEM = "legacy-local-production";
const REVIEW_TAGS = new Set(["test", "test1", "tag_4", "2_2", "tag_8"]);

function asRows(result) {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : [];
}

function insertId(result) {
  const value = Array.isArray(result) && result[0] ? result[0].insertId : null;
  if (!value) throw new Error("insert_id_missing");
  return Number(value);
}

function reviewReason(point, tagCodes) {
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
    return "invalid_coordinates";
  }
  if (tagCodes.some((code) => REVIEW_TAGS.has(code))) return "legacy_test_tag";
  return null;
}

async function main() {
  const inputPath = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!inputPath) throw new Error("usage: import_legacy_road_info.js INPUT.json [--apply]");
  const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (data.format !== "stepby-legacy-road-info-v1") throw new Error("unsupported_export_format");

  const { pool, error } = createDbPool();
  if (!pool || error) throw error || new Error("database_unavailable");
  const conn = await pool.getConnection();
  const summary = { source: data.points.length, existing: 0, insert: 0, active: 0, hidden: 0, needsReview: 0 };

  try {
    await conn.beginTransaction();
    await conn.query(
      `CREATE TABLE IF NOT EXISTS roadinfo.legacy_point_imports (
         source_system text NOT NULL,
         source_point_id bigint NOT NULL,
         point_id bigint NOT NULL REFERENCES roadinfo.road_info_point(id),
         source_status text NOT NULL,
         imported_at timestamptz DEFAULT now() NOT NULL,
         PRIMARY KEY (source_system, source_point_id), UNIQUE (point_id)
       )`
    );

    const userMap = new Map();
    const uniqueUsers = new Map();
    for (const row of data.users || []) {
      const current = uniqueUsers.get(String(row.user_id)) || { ...row, auth: [] };
      if (row.provider) current.auth.push(row);
      uniqueUsers.set(String(row.user_id), current);
    }
    for (const [legacyId, user] of uniqueUsers) {
      let userId = null;
      for (const auth of user.auth) {
        if (auth.provider === "google" && auth.provider_user_id) {
          const rows = asRows(await conn.query(
            `SELECT user_id FROM login.user_auth_providers
              WHERE provider = 'google' AND provider_user_id = ? LIMIT 1`,
            [auth.provider_user_id]
          ));
          if (rows[0]) userId = Number(rows[0].user_id);
        }
      }
      if (!userId) {
        const sameName = asRows(await conn.query(
          `SELECT user_id FROM login.users WHERE username = ? ORDER BY user_id LIMIT 1`,
          [user.username]
        ));
        if (sameName[0] && ["otama", "airpocket"].includes(user.username)) {
          userId = Number(sameName[0].user_id);
        }
      }
      if (!userId) {
        const inserted = await conn.query(
          `INSERT INTO login.users
             (username, icon_url, is_active, email_verified, created_at, updated_at, is_pro, is_guest)
           VALUES (?, ?, true, false, ?, NOW(), ?, ?)
           RETURNING user_id AS id`,
          [user.username, user.icon_url || null, user.created_at || new Date(), Boolean(user.is_pro), Boolean(user.is_guest)]
        );
        userId = insertId(inserted);
        for (const auth of user.auth) {
          if (auth.provider === "google" && auth.provider_user_id) {
            await conn.query(
              `INSERT INTO login.user_auth_providers
                 (user_id, provider, provider_user_id, email, password_hash, created_at)
               VALUES (?, 'google', ?, ?, NULL, NOW())
               ON CONFLICT DO NOTHING
               RETURNING auth_id AS id`,
              [userId, auth.provider_user_id, auth.email || null]
            );
          }
        }
      }
      userMap.set(String(legacyId), userId);
    }

    const tagsByPoint = new Map();
    for (const tag of data.tags || []) {
      const list = tagsByPoint.get(String(tag.point_id)) || [];
      list.push(tag);
      tagsByPoint.set(String(tag.point_id), list);
    }
    const notesByPoint = new Map();
    for (const note of data.notes || []) {
      const list = notesByPoint.get(String(note.point_id)) || [];
      list.push(note);
      notesByPoint.set(String(note.point_id), list);
    }
    const mediaByNote = new Map();
    for (const medium of data.media || []) {
      const list = mediaByNote.get(String(medium.note_id)) || [];
      list.push(medium);
      mediaByNote.set(String(medium.note_id), list);
    }

    for (const point of data.points) {
      const existing = asRows(await conn.query(
        `SELECT point_id FROM roadinfo.legacy_point_imports
          WHERE source_system = ? AND source_point_id = ? LIMIT 1`,
        [SOURCE_SYSTEM, point.id]
      ));
      if (existing[0]) {
        summary.existing += 1;
        continue;
      }
      const pointTags = tagsByPoint.get(String(point.id)) || [];
      const reason = reviewReason(point, pointTags.map((tag) => tag.code));
      const status = point.status;
      summary.insert += 1;
      if (status === "active") summary.active += 1;
      else if (status === "hidden") summary.hidden += 1;
      else summary.needsReview += 1;
      if (reason) summary.needsReview += 1;

      const insertedPoint = await conn.query(
        `INSERT INTO roadinfo.road_info_point
           (geom, status, created_by, created_at, updated_at)
         VALUES (ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?, ?, ?, ?)
         RETURNING id`,
        [Number(point.lng), Number(point.lat), status, userMap.get(String(point.created_by)) || null,
          point.created_at, point.updated_at || point.created_at]
      );
      const pointId = insertId(insertedPoint);
      await conn.query(
        `INSERT INTO roadinfo.legacy_point_imports
           (source_system, source_point_id, point_id, source_status, requires_review, review_reason)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING point_id AS id`,
        [SOURCE_SYSTEM, point.id, pointId, point.status, Boolean(reason), reason]
      );

      for (const tag of pointTags) {
        const tagResult = await conn.query(
          `INSERT INTO roadinfo.road_info_tag (code, label_ja, sort_order, is_active, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (code) DO UPDATE SET label_ja = EXCLUDED.label_ja
           RETURNING id`,
          [tag.code, tag.label_ja, tag.sort_order || 0, tag.is_active !== false, tag.created_at || new Date()]
        );
        await conn.query(
          `INSERT INTO roadinfo.road_info_point_tag (point_id, tag_id)
           VALUES (?, ?) ON CONFLICT DO NOTHING
           RETURNING point_id AS id`,
          [pointId, insertId(tagResult)]
        );
      }

      for (const note of notesByPoint.get(String(point.id)) || []) {
        const insertedNote = await conn.query(
          `INSERT INTO roadinfo.road_info_note
             (point_id, body, created_by, created_at, is_deleted)
           VALUES (?, ?, ?, ?, ?) RETURNING id`,
          [pointId, note.body, userMap.get(String(note.created_by)) || null, note.created_at, Boolean(note.is_deleted)]
        );
        const noteId = insertId(insertedNote);
        for (const medium of mediaByNote.get(String(note.id)) || []) {
          const fileName = path.basename(String(medium.url || ""));
          const migratedUrl = fileName ? `/uploads/road_info_media/${fileName}` : medium.url;
          await conn.query(
            `INSERT INTO roadinfo.road_info_media
               (note_id, media_type, url, created_by, created_at, is_deleted)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [noteId, medium.media_type || "image", migratedUrl,
              userMap.get(String(medium.created_by)) || null, medium.created_at, Boolean(medium.is_deleted)]
          );
        }
      }
    }

    // 画面の実績値も、現行DBへ移した未削除投稿数に合わせる。
    await conn.query(
      `UPDATE login.users u
          SET total_road_posts = counts.total
         FROM (
           SELECT created_by, COUNT(*)::integer AS total
             FROM roadinfo.road_info_point
            WHERE status <> 'deleted' AND created_by IS NOT NULL
            GROUP BY created_by
         ) counts
        WHERE u.user_id = counts.created_by`
    );

    if (apply) await conn.commit();
    else await conn.rollback();
    process.stdout.write(`${JSON.stringify({ mode: apply ? "apply" : "dry-run", ...summary })}\n`);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
