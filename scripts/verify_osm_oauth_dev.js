const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const security = JSON.parse(fs.readFileSync(path.join(projectRoot, "config.security.dev.json"), "utf8"));
process.env.ACCESS_TOKEN_SECRET = security.accessTokenSecret;
process.env.DB_CONFIG_PATH = path.join(projectRoot, "config.dev.yaml");

const { createDbPool } = require("../server/db");
const { createAccessToken } = require("../server/auth_token");

(async () => {
  const { pool } = createDbPool();
  if (!pool) throw new Error("database_unavailable");
  const [users] = await pool.query("SELECT user_id FROM login.users ORDER BY user_id LIMIT 1");
  if (!users[0]) throw new Error("no_development_user_available");
  const token = createAccessToken(users[0].user_id, { expiresInSeconds: 60 });
  const response = await fetch("http://127.0.0.1:3100/auth/osm/status", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`status_failed_${response.status}`);
  const [tables] = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='login' AND table_name IN ('osm_connections','osm_oauth_states','osm_connection_audit')`
  );
  if (tables.length !== 3) throw new Error("osm_oauth_tables_missing");
  console.log(JSON.stringify({
    statusCode: response.status,
    configured: payload.configured,
    connected: payload.connected,
    osmWritesEnabled: payload.osmWritesEnabled === true,
    tables: tables.map((row) => row.table_name).sort(),
  }));
  process.exit(0);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
