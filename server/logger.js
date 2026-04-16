const fs = require("fs");
const path = require("path");

// ログファイルが肥大化しすぎないよう、既定の最大サイズを 1MB に抑える。
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;

// CSVの1行に安全に埋め込めるよう、各フィールドを引用符で包む。
function toCsv(fields) {
  return fields
    .map((field) => {
      const value = String(field ?? "");
      const escaped = value.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(",");
}

// 指定ファイルにCSVログを追記するロガーを作る。
function createLogger(logFilePath, options = {}) {
  let writeQueue = Promise.resolve();
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;

  // ログ出力先ディレクトリがなければ作成する。
  function ensureLogDir() {
    try {
      const dir = path.dirname(logFilePath);
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  }

  // 追記前に上限超過を見積もり、超える場合はファイル全体を空にして回転なしで継続する。
  async function truncateIfNeeded(incomingBytes) {
    let stats;
    try {
      stats = await fs.promises.stat(logFilePath);
    } catch {
      return;
    }

    if ((stats.size + incomingBytes) <= maxBytes) {
      return;
    }

    try {
      await fs.promises.truncate(logFilePath, 0);
    } catch {
      // ignore truncate failure
    }
  }

  // 1イベントを「timestamp,level,message」のCSVで追記する。
  function appendLog(level, message) {
    const timestamp = new Date().toISOString();
    const line = `${toCsv([timestamp, level, message])}\n`;
    const incomingBytes = Buffer.byteLength(line, "utf8");

    // ログ書き込みを直列化して、切り捨てと追記の順序を保つ。
    writeQueue = writeQueue
      .then(async () => {
        ensureLogDir();
        await truncateIfNeeded(incomingBytes);
        await fs.promises.appendFile(logFilePath, line, "utf8");
      })
      .catch(() => {
        // ignore write errors
      });
  }

  ensureLogDir();
  return { appendLog };
}

module.exports = { createLogger };
