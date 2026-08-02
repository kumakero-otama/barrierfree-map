const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const yaml = require("yaml");
const { Client } = require("pg");

const repoRoot = path.resolve(__dirname, "..");
const adminConfigPath = path.resolve(process.argv[2] || "/home/otama/barrierfree-map/config.yaml");
const devConfigPath = path.join(repoRoot, "config.experiment.dev.yaml");
const roleName = "stepby_experiment_dev";
const databaseName = "stepby_experiment_dev";

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function connect(config, database) {
  const client = new Client({
    host: config.host,
    port: config.port || 5432,
    user: config.user,
    password: config.password,
    database,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  return client;
}

(async () => {
  const adminConfig = yaml.parse(fs.readFileSync(adminConfigPath, "utf8")).db;
  const admin = await connect(adminConfig, adminConfig.database);
  const password = crypto.randomBytes(32).toString("base64url");
  try {
    const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleName]);
    if (role.rowCount === 0) {
      await admin.query(`CREATE ROLE ${quoteIdentifier(roleName)} LOGIN PASSWORD ${quoteLiteral(password)}`);
    } else {
      await admin.query(`ALTER ROLE ${quoteIdentifier(roleName)} PASSWORD ${quoteLiteral(password)}`);
    }
    const database = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (database.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(roleName)}`);
    }
  } finally {
    await admin.end();
  }

  const dev = await connect({ ...adminConfig, user: roleName, password }, databaseName);
  try {
    await dev.query("CREATE SCHEMA IF NOT EXISTS experiment AUTHORIZATION CURRENT_USER");
    await dev.query(`
      CREATE TABLE IF NOT EXISTS experiment.fitting_comparisons (
        id BIGSERIAL PRIMARY KEY,
        experiment_session_uuid TEXT,
        user_id TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        raw_lat DOUBLE PRECISION NOT NULL,
        raw_lng DOUBLE PRECISION NOT NULL,
        valhalla_lat DOUBLE PRECISION,
        valhalla_lng DOUBLE PRECISION,
        valhalla_way_id BIGINT,
        valhalla_distance_m DOUBLE PRECISION,
        browser_lat DOUBLE PRECISION,
        browser_lng DOUBLE PRECISION,
        browser_way_id BIGINT,
        browser_way_version INTEGER,
        browser_distance_m DOUBLE PRECISION,
        browser_priority TEXT,
        result_distance_m DOUBLE PRECISION,
        way_match BOOLEAN,
        browser_connected BOOLEAN,
        valhalla_duration_ms INTEGER,
        browser_duration_ms INTEGER,
        status TEXT NOT NULL,
        error_message TEXT,
        client_version TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await dev.query("CREATE INDEX IF NOT EXISTS fitting_comparisons_created_idx ON experiment.fitting_comparisons (created_at DESC)");
    await dev.query("CREATE INDEX IF NOT EXISTS fitting_comparisons_session_idx ON experiment.fitting_comparisons (experiment_session_uuid, created_at)");
    await dev.query(`
      CREATE OR REPLACE FUNCTION experiment.prevent_fitting_history_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'fitting_comparisons is append-only';
      END $$
    `);
    await dev.query("DROP TRIGGER IF EXISTS fitting_comparisons_append_only ON experiment.fitting_comparisons");
    await dev.query(`
      CREATE TRIGGER fitting_comparisons_append_only
      BEFORE UPDATE OR DELETE ON experiment.fitting_comparisons
      FOR EACH ROW EXECUTE FUNCTION experiment.prevent_fitting_history_mutation()
    `);
  } finally {
    await dev.end();
  }

  const devConfig = {
    db: {
      host: adminConfig.host,
      port: adminConfig.port || 5432,
      user: roleName,
      password,
      database: databaseName,
      ssl: Boolean(adminConfig.ssl),
    },
  };
  fs.writeFileSync(devConfigPath, yaml.stringify(devConfig), { mode: 0o600 });
  fs.chmodSync(devConfigPath, 0o600);
  console.log(`Provisioned isolated database ${databaseName} and append-only comparison table.`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
