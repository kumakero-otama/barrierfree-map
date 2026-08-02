const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const yaml = require("yaml");
const { Client } = require("pg");

const repoRoot = path.resolve(__dirname, "..");
const adminConfigPath = path.resolve(process.argv[2] || "/home/otama/barrierfree-map/config.yaml");
const devConfigPath = path.join(repoRoot, "config.dev.yaml");
const roleName = "stepby_app_dev";
const databaseName = "stepby_app_dev";

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function connectionArgs(config, database) {
  return ["-h", config.host, "-p", String(config.port || 5432), "-U", config.user, "-d", database];
}

function runSchemaCopy(adminConfig) {
  return new Promise((resolve, reject) => {
    const dump = spawn("pg_dump", [
      ...connectionArgs(adminConfig, adminConfig.database),
      "--schema-only",
      "--no-owner",
      "--no-privileges",
    ], {
      env: { ...process.env, PGPASSWORD: String(adminConfig.password || "") },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const restore = spawn("psql", [
      "-v", "ON_ERROR_STOP=1",
      ...connectionArgs(adminConfig, databaseName),
    ], {
      env: { ...process.env, PGPASSWORD: String(adminConfig.password || "") },
      stdio: ["pipe", "ignore", "pipe"],
    });
    dump.stdout.pipe(restore.stdin);

    let dumpError = "";
    let restoreError = "";
    dump.stderr.on("data", (chunk) => { dumpError += chunk; });
    restore.stderr.on("data", (chunk) => { restoreError += chunk; });

    let dumpCode;
    let restoreCode;
    const finish = () => {
      if (dumpCode === undefined || restoreCode === undefined) return;
      if (dumpCode === 0 && restoreCode === 0) resolve();
      else reject(new Error(`schema_copy_failed dump=${dumpCode} restore=${restoreCode}: ${dumpError || restoreError}`));
    };
    dump.on("close", (code) => { dumpCode = code; finish(); });
    restore.on("close", (code) => { restoreCode = code; finish(); });
    dump.on("error", reject);
    restore.on("error", reject);
  });
}

async function connect(config, database, user = config.user, password = config.password) {
  const client = new Client({
    host: config.host,
    port: config.port || 5432,
    user,
    password,
    database,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  return client;
}

(async () => {
  if (fs.existsSync(devConfigPath)) {
    throw new Error("config.dev.yaml already exists; refusing to replace an existing development database configuration");
  }

  const adminConfig = yaml.parse(fs.readFileSync(adminConfigPath, "utf8")).db;
  const admin = await connect(adminConfig, adminConfig.database);
  const password = crypto.randomBytes(32).toString("base64url");
  try {
    const existingDatabase = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (existingDatabase.rowCount !== 0) {
      throw new Error(`${databaseName} already exists; refusing to modify it`);
    }
    const existingRole = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleName]);
    if (existingRole.rowCount === 0) {
      await admin.query(`CREATE ROLE ${quoteIdentifier(roleName)} LOGIN PASSWORD ${quoteLiteral(password)}`);
    } else {
      await admin.query(`ALTER ROLE ${quoteIdentifier(roleName)} PASSWORD ${quoteLiteral(password)}`);
    }
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(roleName)}`);
  } finally {
    await admin.end();
  }

  // PostGIS installation requires the administrative role. Application tables
  // are restored afterward as the development role, so all app objects belong
  // only to the isolated development account.
  const devAdmin = await connect(adminConfig, databaseName);
  try {
    await devAdmin.query("CREATE EXTENSION IF NOT EXISTS postgis");
  } finally {
    await devAdmin.end();
  }

  await runSchemaCopy(adminConfig);

  const privilegeAdmin = await connect(adminConfig, databaseName);
  try {
    const appSchemas = ["login", "roadinfo", "tactile"];
    for (const schemaName of appSchemas) {
      const schema = quoteIdentifier(schemaName);
      const role = quoteIdentifier(roleName);
      await privilegeAdmin.query(`ALTER SCHEMA ${schema} OWNER TO ${role}`);
      const relations = await privilegeAdmin.query(`
        SELECT c.relname, c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm')
      `, [schemaName]);
      for (const relation of relations.rows) {
        const objectType = relation.relkind === "v" ? "VIEW"
          : relation.relkind === "m" ? "MATERIALIZED VIEW"
          : "TABLE";
        await privilegeAdmin.query(
          `ALTER ${objectType} ${schema}.${quoteIdentifier(relation.relname)} OWNER TO ${role}`
        );
      }
      const functions = await privilegeAdmin.query(`
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1
      `, [schemaName]);
      for (const fn of functions.rows) {
        await privilegeAdmin.query(
          `ALTER FUNCTION ${schema}.${quoteIdentifier(fn.proname)}(${fn.args}) OWNER TO ${role}`
        );
      }
    }
    const schemas = await privilegeAdmin.query(`
      SELECT nspname FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema')
        AND nspname NOT LIKE 'pg_toast%'
    `);
    for (const { nspname } of schemas.rows) {
      const schema = quoteIdentifier(nspname);
      const role = quoteIdentifier(roleName);
      await privilegeAdmin.query(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role}`);
      await privilegeAdmin.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
      await privilegeAdmin.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
      await privilegeAdmin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`);
      await privilegeAdmin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO ${role}`);
      await privilegeAdmin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON SEQUENCES TO ${role}`);
      await privilegeAdmin.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${role}`);
    }
  } finally {
    await privilegeAdmin.end();
  }

  const dev = await connect(adminConfig, databaseName, roleName, password);
  try {
    await dev.query("SELECT 1");
    const userTableCount = await dev.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        AND NOT (schemaname = 'public' AND tablename = 'spatial_ref_sys')
    `);
    const userRowCount = await dev.query(`
      SELECT COALESCE(SUM(n_live_tup), 0)::bigint AS count
      FROM pg_stat_user_tables
      WHERE NOT (schemaname = 'public' AND relname = 'spatial_ref_sys')
    `);
    if (Number(userRowCount.rows[0].count) !== 0) {
      throw new Error("development database unexpectedly contains application data");
    }
    console.log(`Created isolated empty development database with ${userTableCount.rows[0].count} application tables.`);
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
  console.log(`Wrote ${devConfigPath}; no production application rows were copied.`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
