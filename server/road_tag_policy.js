// 現行StepByで使われている道情報タグを、空の開発DBにも同じ順序で用意する。
// 実行時に本番DBへ接続せず、参照用マスターだけを開発DB内へ複製する。
const CURRENT_ROAD_TAGS = [
  ["audible_signal", "音が鳴る信号機", 1],
  ["non_audible_signal", "音が鳴らない信号機", 2],
  ["push_button_signal", "押しボタン式信号機", 3],
  ["crosswalk", "横断歩道", 4],
  ["misplaced_tactile_paving", "配置が不適切な点字ブロック", 5],
  ["deteriorated_tactile_paving", "劣化した点字ブロック", 6],
  ["obstructed_tactile_paving", "物が置かれて通れない点字ブロック", 7],
  ["footbridge_stairs_entry", "歩道橋の階段の出入口", 8],
  ["footbridge_elevator_entry", "歩道橋のエレベーターの出入口", 9],
  ["footbridge_ramp_entry", "歩道橋のスロープの出入口", 10],
  ["tag_3", "感知式信号機", 17],
  ["tag_4", "テスト用", 18],
  ["tag_5", "時間式信号機", 19],
  ["tag_6", "やさしい点字ブロック", 20],
  ["tag_7", "工事中", 21],
  ["2_2", "テスト用2", 22],
  ["complete", "complete", 23],
  ["test", "test", 24],
  ["tag_8", "テスト", 25],
  ["test1", "test１", 26],
  ["tag_9", "道草", 27],
  ["tag_10", "ベンチ", 28],
  ["tag_11", "休憩", 29],
];

let ensurePromise = null;

async function ensureCurrentRoadTags(pool) {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      for (const [code, label, order] of CURRENT_ROAD_TAGS) {
        await pool.query(
          `INSERT INTO roadinfo.road_info_tag(code,label_ja,sort_order,is_active)
           VALUES(?,?,?,TRUE)
           ON CONFLICT(code) DO UPDATE SET
             label_ja=EXCLUDED.label_ja,
             sort_order=EXCLUDED.sort_order,
             is_active=TRUE`,
          [code, label, order]
        );
      }
    })().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  await ensurePromise;
}

module.exports = { CURRENT_ROAD_TAGS, ensureCurrentRoadTags };
