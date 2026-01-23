const fs = require("fs");
const path = require("path");
const yaml = require("yaml");
const mysql = require("mysql2/promise");

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
      pool: mysql.createPool({
        host: dbConfig.host,
        port: dbConfig.port || 3306,
        user: dbConfig.user,
        password: dbConfig.password,
        database: dbConfig.database,
        waitForConnections: true,
        connectionLimit: 5,
        queueLimit: 0,
      }),
      error: null,
    };
  } catch (err) {
    return { pool: null, error: err };
  }
}

module.exports = { createDbPool };
