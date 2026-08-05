const path = require("path");
process.env.DB_CONFIG_PATH = process.env.DB_CONFIG_PATH || path.resolve(__dirname, "..", "config.dev.yaml");
const { createDbPool } = require("../server/db");

(async () => {
  const { pool } = createDbPool();
  if (!pool) throw new Error("database_unavailable");
  const [database] = await pool.query("SELECT current_database() database_name, pg_database_size(current_database()) bytes");
  const [columns] = await pool.query(`
    SELECT table_schema,table_name,column_name,data_type,udt_name
      FROM information_schema.columns
     WHERE (table_schema='tactile' AND table_name IN ('sessions','gps_raw','gps_matched') AND column_name='session_id')
        OR (table_schema='osmchange' AND table_name='record_links' AND column_name='record_id')
     ORDER BY table_schema,table_name,column_name
  `);
  console.log(JSON.stringify({ database: database[0], identifierColumns: columns }, null, 2));
  process.exit(0);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
