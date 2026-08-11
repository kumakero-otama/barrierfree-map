const { createDbPool } = require("../server/db");

const batchId = process.argv[2];
if (!/^[0-9a-f-]{36}$/i.test(String(batchId || ""))) throw new Error("batch_id_required");

async function run() {
  const { pool, error } = createDbPool();
  if (!pool) throw error || new Error("database_unavailable");
  await pool.query("UPDATE experiment.production_fitting_batches SET status=?,completed_at=COALESCE(completed_at,NOW()) WHERE batch_id=?", ["complete", batchId]);
  const [rows] = await pool.query(`SELECT count(*)::int compared,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY (valhalla_result->>'meanDifferenceMeters')::double precision) median_difference_m,
    percentile_cont(0.9) WITHIN GROUP(ORDER BY (valhalla_result->>'meanDifferenceMeters')::double precision) p90_difference_m,
    percentile_cont(0.95) WITHIN GROUP(ORDER BY (valhalla_result->>'meanDifferenceMeters')::double precision) p95_difference_m,
    count(*) FILTER(WHERE (valhalla_result->>'meanDifferenceMeters')::double precision<=5)::int within_5m,
    count(*) FILTER(WHERE (valhalla_result->>'meanDifferenceMeters')::double precision<=10)::int within_10m,
    max((valhalla_result->>'meanDifferenceMeters')::double precision) max_mean_difference_m,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY (valhalla_result->>'wayJaccard')::double precision) median_way_jaccard,
    percentile_cont(0.1) WITHIN GROUP(ORDER BY (valhalla_result->>'wayJaccard')::double precision) p10_way_jaccard,
    count(*) FILTER(WHERE (valhalla_result->>'wayJaccard')::double precision=1)::int exact_way_sets,
    count(*) FILTER(WHERE (valhalla_result->>'wayJaccard')::double precision<0.5)::int low_way_overlap,
    percentile_cont(0.5) WITHIN GROUP(ORDER BY (browser_result->>'meanSnapDistance')::double precision) median_browser_snap_m,
    count(*) FILTER(WHERE (browser_result->>'connected')::boolean)::int connected,
    count(*) FILTER(WHERE (valhalla_result->>'fallback')::boolean)::int valhalla_fallback
    FROM experiment.production_fitting_batch_results WHERE batch_id=? AND status='compared'`, [batchId]);
  console.log(JSON.stringify(rows[0]));
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
