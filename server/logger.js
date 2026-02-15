const fs = require("fs");
const path = require("path");

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
function createLogger(logFilePath) {
  // ログ出力先ディレクトリがなければ作成する。
  function ensureLogDir() {
    try {
      const dir = path.dirname(logFilePath);
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  }

  // 1イベントを「timestamp,level,message」のCSVで追記する。
  function appendLog(level, message) {
    const timestamp = new Date().toISOString();
    const line = `${toCsv([timestamp, level, message])}\n`;
    // 非同期書き込みでI/Oブロッキングを回避
    fs.appendFile(logFilePath, line, "utf8", (err) => {
      // ignore write errors
    });
  }

  ensureLogDir();
  return { appendLog };
}

module.exports = { createLogger };
