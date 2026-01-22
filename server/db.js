const fs = require("fs");
const path = require("path");
const yaml = require("yaml");
const mariadb = require("mariadb");

const CONFIG_PATH = path.join(__dirname, "..", "config.yaml");

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = yaml.parse(raw);
  if (!parsed || !parsed.db) {
    throw new Error("missing_db_config");
  }
  return parsed.db;
}

function createDbPool() {
  try {
    const dbConfig = loadConfig();
    return {
      pool: mariadb.createPool({
        host: dbConfig.host,
        port: dbConfig.port || 3306,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
        connectionLimit: 5,
      }),
      error: null,
    };
  } catch (err) {
    return { pool: null, error: err };
  }
}

module.exports = { createDbPool };
