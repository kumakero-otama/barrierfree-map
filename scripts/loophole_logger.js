const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const LOG_DIR = path.join(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "loophole.csv");
const LOOPHOLE_BIN = path.join(
  __dirname,
  "..",
  "loophole-cli_1.0.0-beta.15_linux_64bit",
  "loophole"
);
const LOOPHOLE_ARGS = ["http", "3000", "--hostname", "barrierfree-map"];

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

function toCsv(fields) {
  return fields
    .map((field) => {
      const value = String(field ?? "");
      const escaped = value.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(",");
}

function appendLog(level, message) {
  const timestamp = new Date().toISOString();
  const line = `${toCsv([timestamp, level, message])}\n`;
  // 非同期書き込みでI/Oブロッキングを回避
  fs.appendFile(LOG_FILE, line, "utf8", (err) => {
    // ignore write errors
  });
}

ensureLogDir();
appendLog("INFO", "loophole_logger_start");

const child = spawn(LOOPHOLE_BIN, LOOPHOLE_ARGS, {
  stdio: ["ignore", "pipe", "pipe"],
});

const stdoutRl = readline.createInterface({ input: child.stdout });
stdoutRl.on("line", (line) => {
  appendLog("INFO", line);
  process.stdout.write(`${line}\n`);
});

const stderrRl = readline.createInterface({ input: child.stderr });
stderrRl.on("line", (line) => {
  appendLog("ERROR", line);
  process.stderr.write(`${line}\n`);
});

child.on("exit", (code, signal) => {
  appendLog("WARN", `loophole_exit code=${code ?? "null"} signal=${signal ?? "null"}`);
  process.exit(code ?? 1);
});
