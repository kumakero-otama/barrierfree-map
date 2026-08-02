const fs = require("fs");
const path = require("path");
const yaml = require("yaml");
const { Pool } = require("pg");
const { createLogger } = require("./logger");

const CONFIG_PATH = process.env.DB_CONFIG_PATH
  ? path.resolve(process.env.DB_CONFIG_PATH)
  : path.join(__dirname, "..", "config.yaml");
const LOG_DIR = path.join(__dirname, "..", "logs");
const DB_LOG = path.join(LOG_DIR, "db_connection.csv");

// DB 初期化の成否や設定読み込み結果を記録する専用ロガー。
const dbLogger = createLogger(DB_LOG);

// 本番は従来のconfig.yaml、開発はDB_CONFIG_PATHで分離した設定を読む。
function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const parsed = yaml.parse(raw);
  if (!parsed || !parsed.db) {
    throw new Error("missing_db_config");
  }
  return parsed.db;
}

// MySQL互換の ? プレースホルダを PostgreSQL の $1 形式へ変換する。
function toPgSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

// INSERT文にRETURNINGがない場合、insertId互換を得るために補完が必要か判定する。
function needsReturningId(sql) {
  return /^\s*insert\s+/i.test(sql) && !/\breturning\b/i.test(sql);
}

// pgの結果を既存コード互換（rows / insertId / affectedRows）に整形する。
function makeCompatResult(sql, result) {
  if (/^\s*select\s+/i.test(sql) || /^\s*with\s+/i.test(sql)) {
    return [result.rows];
  }
  if (/^\s*insert\s+/i.test(sql)) {
    return [
      {
        insertId: result.rows[0] && result.rows[0].id ? result.rows[0].id : null,
        affectedRows: result.rowCount,
        rowCount: result.rowCount,
      },
    ];
  }
  return [
    {
      affectedRows: result.rowCount,
      rowCount: result.rowCount,
    },
  ];
}

class PgCompatConnection {
  constructor(client) {
    this.client = client;
  }

  // 既存コードの query(sql, params) をそのまま使えるよう変換して実行する。
  async query(sql, params = []) {
    const baseSql = toPgSql(sql);
    const pgSql = needsReturningId(baseSql) ? `${baseSql} RETURNING id` : baseSql;
    const result = await this.client.query(pgSql, params);
    return makeCompatResult(baseSql, result);
  }

  async beginTransaction() {
    // mysql2 互換の beginTransaction API を pg クライアントへ橋渡しする。
    await this.client.query("BEGIN");
  }

  async commit() {
    // トランザクション確定も既存コードの呼び方に合わせる。
    await this.client.query("COMMIT");
  }

  async rollback() {
    // 失敗時は呼び出し元が明示的にロールバックできるようにする。
    await this.client.query("ROLLBACK");
  }

  release() {
    // 接続リーク防止のため、取得したクライアントは必ず pool へ返却する。
    this.client.release();
  }
}

class PgCompatPool {
  constructor(pool) {
    this.pool = pool;
  }

  // プール直実行時も同じ互換ルールで結果を返す。
  async query(sql, params = []) {
    const baseSql = toPgSql(sql);
    const pgSql = needsReturningId(baseSql) ? `${baseSql} RETURNING id` : baseSql;
    const result = await this.pool.query(pgSql, params);
    return makeCompatResult(baseSql, result);
  }

  // トランザクション用コネクションを取得する。
  async getConnection() {
    const client = await this.pool.connect();
    return new PgCompatConnection(client);
  }
}

// DBプールを初期化し、利用可否を呼び出し元へ返す。
function createDbPool() {
  try {
    const dbConfig = loadConfig();
    
    // デバッグ用：設定内容をログ出力（パスワードはマスク）
    const pwd = dbConfig.password || '';
    const firstChar = pwd.length > 0 ? pwd.charCodeAt(0) : 0;
    const lastChar = pwd.length > 0 ? pwd.charCodeAt(pwd.length - 1) : 0;
    const configInfo = `host=${dbConfig.host},port=${dbConfig.port || 5432},user=${dbConfig.user},database=${dbConfig.database},passwordLength=${pwd.length},passwordExists=${!!dbConfig.password},firstCharCode=${firstChar},lastCharCode=${lastChar}`;
    dbLogger.appendLog("INFO", `DB設定読み込み: ${configInfo}`);

    const pool = new Pool({
      host: dbConfig.host,
      port: dbConfig.port || 5432,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      max: 5,
      ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined,
    });

    // 起動直後に軽い疎通確認を流し、設定不備を早期にログへ残す。
    pool.query("SELECT 1")
      .then(() => {
        dbLogger.appendLog("INFO", "DB接続テスト成功");
      })
      .catch((err) => {
        dbLogger.appendLog("ERROR", `DB接続テスト失敗: ${err.message} (code: ${err.code})`);
      });
    
    return {
      pool: new PgCompatPool(pool),
      error: null,
    };
  } catch (err) {
    dbLogger.appendLog("ERROR", `DB初期化エラー: ${err.message}`);
    return { pool: null, error: err };
  }
}

module.exports = { createDbPool };
