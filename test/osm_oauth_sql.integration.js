const path = require("path");
process.env.DB_CONFIG_PATH = process.env.DB_CONFIG_PATH || path.resolve(__dirname, "..", "config.dev.yaml");
const { createDbPool } = require("../server/db");

(async () => {
  const { pool } = createDbPool();
  if (!pool) throw new Error("database_unavailable");
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [users] = await connection.query("SELECT user_id FROM login.users ORDER BY user_id LIMIT 1");
    if (!users[0]) throw new Error("no_development_user_available");
    const userId = users[0].user_id;
    const stateHash = `sql_test_${Date.now()}`;
    await connection.query(
      `INSERT INTO login.osm_oauth_states
       (state_hash,user_id,code_verifier_encrypted,return_url,flow_mode,expires_at)
       VALUES (?,?,?,?,?,CURRENT_TIMESTAMP + INTERVAL '10 minutes') RETURNING state_hash`,
      [stateHash, userId, "test.encrypted.value", "https://kumakero-otama.github.io/StepBy/UI10/profile/Index.html", "popup"]
    );
    await connection.query(
      `INSERT INTO login.osm_connection_audit
       (user_id,event_type,details) VALUES (?,?,?::jsonb) RETURNING audit_id`,
      [userId, "sql_rollback_test", JSON.stringify({ rollback: true })]
    );
    await connection.rollback();
    console.log("osm_oauth_sql.integration: passed and rolled back; no OSM network used");
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
  process.exit(0);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
