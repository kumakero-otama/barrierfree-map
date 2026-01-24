const fs = require("fs");
const path = require("path");

function toCsv(fields) {
  return fields
    .map((field) => {
      const value = String(field ?? "");
      const escaped = value.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(",");
}

function createLogger(logFilePath) {
  function ensureLogDir() {
    try {
      const dir = path.dirname(logFilePath);
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }
  }

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
