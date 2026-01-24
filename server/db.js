const fs = require("fs");
const path = require("path");
const yaml = require("yaml");
const mysql = require("mysql2/promise");
const { createLogger } = require("./logger");

const CONFIG_PATH = path.join(__dirname, "..", "config.yaml");
const LOG_DIR = path.join(__dirname, "..", "logs");
const DB_LOG = path.join(LOG_DIR, "db_connection.csv");

const dbLogger = createLogger(DB_LOG);

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
    
    // デバッグ用：設定内容をログ出力（パスワードはマスク）
    const pwd = dbConfig.password || '';
    const firstChar = pwd.length > 0 ? pwd.charCodeAt(0) : 0;
    const lastChar = pwd.length > 0 ? pwd.charCodeAt(pwd.length - 1) : 0;
    const configInfo = `host=${dbConfig.host},port=${dbConfig.port || 3306},user=${dbConfig.user},database=${dbConfig.database},passwordLength=${pwd.length},passwordExists=${!!dbConfig.password},firstCharCode=${firstChar},lastCharCode=${lastChar}`;
    dbLogger.appendLog("INFO", `DB設定読み込み: ${configInfo}`);
    
    const pool = mysql.createPool({
      host: dbConfig.host,
      port: dbConfig.port || 3306,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      charset: 'utf8mb4',
      insecureAuth: true,
    });
    
    // 接続テスト
    pool.query('SELECT 1')
      .then(() => {
        dbLogger.appendLog("INFO", "DB接続テスト成功");
      })
      .catch((err) => {
        dbLogger.appendLog("ERROR", `DB接続テスト失敗: ${err.message} (code: ${err.code})`);
      });
    
    return {
      pool,
      error: null,
    };
  } catch (err) {
    dbLogger.appendLog("ERROR", `DB初期化エラー: ${err.message}`);
    return { pool: null, error: err };
  }
}

module.exports = { createDbPool };
