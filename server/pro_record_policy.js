const PUBLIC_TAG_CODES = new Set([
  "tactile_paving",
  "tactile_paving_jis",
  "tactile_paving_non_jis",
]);

const SYSTEM_TAGS = [
  ["tactile_paving", "点字ブロック", true, "green", 10],
  ["tactile_paving_jis", "JISの点字ブロック", true, "green", 20],
  ["tactile_paving_non_jis", "JISではない点字ブロック", true, "green", 30],
  ["fence", "柵", false, "red", 100],
  ["wall", "塀", false, "red", 110],
  ["grating", "グレーチング", false, "red", 120],
  ["waterway_cover", "用水路の蓋", false, "red", 130],
  ["legacy_test", "テスト用", false, "red", 800],
  ["legacy_test_2", "テスト用2", false, "red", 810],
  ["pro_note", "その他の歩行支援情報", false, "red", 900],
];

async function ensureProTagSchema(pool) {
  await pool.query("ALTER TABLE tactile.tags ADD COLUMN IF NOT EXISTS osm_exportable BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("ALTER TABLE tactile.tags ADD COLUMN IF NOT EXISTS display_color TEXT NOT NULL DEFAULT 'red'");
  await pool.query("ALTER TABLE tactile.tags ADD COLUMN IF NOT EXISTS system_defined BOOLEAN NOT NULL DEFAULT FALSE");
  for (const [code, label, exportable, color, order] of SYSTEM_TAGS) {
    await pool.query(
      `INSERT INTO tactile.tags(code,label_ja,sort_order,is_active,osm_exportable,display_color,system_defined)
       VALUES(?,?,?,TRUE,?,?,TRUE)
       ON CONFLICT(code) DO UPDATE SET label_ja=EXCLUDED.label_ja, sort_order=EXCLUDED.sort_order,
         is_active=TRUE, osm_exportable=EXCLUDED.osm_exportable,
         display_color=EXCLUDED.display_color, system_defined=TRUE`,
      [code, label, order, exportable, color]
    );
  }
}

async function getRecordPublication(pool, recordId, userId) {
  await ensureProTagSchema(pool);
  const [rows] = await pool.query(
    `SELECT s.session_id, COALESCE(u.is_pro,FALSE) AS is_pro,
       COALESCE(BOOL_OR(t.osm_exportable),FALSE) AS has_public_tag,
       COALESCE(BOOL_OR(NOT t.osm_exportable),FALSE) AS has_private_tag,
       COALESCE(ARRAY_AGG(t.code) FILTER (WHERE t.code IS NOT NULL),ARRAY[]::text[]) AS tag_codes
     FROM tactile.sessions s
     JOIN login.users u ON u.user_id=s.user_id
     LEFT JOIN tactile.session_tags st ON st.session_id=s.session_id
     LEFT JOIN tactile.tags t ON t.id=st.tag_id
     WHERE s.session_id=? AND s.user_id=?
     GROUP BY s.session_id,u.is_pro`,
    [recordId, userId]
  );
  if (!rows[0]) throw new Error("record_not_found_or_forbidden");
  const row = rows[0];
  return {
    isPro: Boolean(row.is_pro),
    hasPublicTag: Boolean(row.has_public_tag),
    hasPrivateTag: Boolean(row.has_private_tag),
    tagCodes: Array.isArray(row.tag_codes) ? row.tag_codes : [],
    osmEligible: !row.is_pro || Boolean(row.has_public_tag),
  };
}

module.exports = { PUBLIC_TAG_CODES, SYSTEM_TAGS, ensureProTagSchema, getRecordPublication };
