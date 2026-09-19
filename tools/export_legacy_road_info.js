#!/usr/bin/env node
"use strict";

// 旧DBを変更せず、未削除の道情報と関連データだけをJSONへ書き出す。
const fs = require("fs");
const { createDbPool } = require("../server/db");

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error("usage: export_legacy_road_info.js OUTPUT.json");

  const { pool, error } = createDbPool();
  if (!pool || error) throw error || new Error("database_unavailable");

  const [points] = await pool.query(
    `SELECT id, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lng,
            status, created_by, created_at, updated_at
       FROM roadinfo.road_info_point
      WHERE status IN ('active', 'hidden')
      ORDER BY id`
  );
  const pointIds = points.map((point) => Number(point.id));
  if (!pointIds.length) throw new Error("no_legacy_points_found");

  const [tags] = await pool.query(
    `SELECT pt.point_id, t.code, t.label_ja, t.sort_order, t.is_active, t.created_at
       FROM roadinfo.road_info_point_tag pt
       JOIN roadinfo.road_info_tag t ON t.id = pt.tag_id
      WHERE pt.point_id = ANY($1::bigint[])
      ORDER BY pt.point_id, t.sort_order, t.id`,
    [pointIds]
  );
  const [notes] = await pool.query(
    `SELECT id, point_id, body, created_by, created_at, is_deleted
       FROM roadinfo.road_info_note
      WHERE point_id = ANY($1::bigint[])
      ORDER BY point_id, created_at, id`,
    [pointIds]
  );
  const noteIds = notes.map((note) => Number(note.id));
  const [media] = noteIds.length
    ? await pool.query(
        `SELECT id, note_id, media_type, url, created_by, created_at, is_deleted
           FROM roadinfo.road_info_media
          WHERE note_id = ANY($1::bigint[])
          ORDER BY note_id, created_at, id`,
        [noteIds]
      )
    : [[]];

  const userIds = [...new Set([
    ...points.map((row) => Number(row.created_by)).filter(Boolean),
    ...notes.map((row) => Number(row.created_by)).filter(Boolean),
    ...media.map((row) => Number(row.created_by)).filter(Boolean),
  ])];
  const [users] = userIds.length
    ? await pool.query(
        `SELECT u.user_id, u.username, u.icon_url, u.created_at, u.is_pro, u.is_guest,
                a.provider, a.provider_user_id, a.email
           FROM login.users u
           LEFT JOIN login.user_auth_providers a ON a.user_id = u.user_id
          WHERE u.user_id = ANY($1::bigint[])
          ORDER BY u.user_id, a.auth_id`,
        [userIds]
      )
    : [[]];

  const exportData = {
    format: "stepby-legacy-road-info-v1",
    exportedAt: new Date().toISOString(),
    counts: { points: points.length, notes: notes.length, media: media.length },
    points,
    tags,
    notes,
    media,
    users,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(exportData, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(exportData.counts)}\n`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

