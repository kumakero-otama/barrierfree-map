const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");
const { createLogger } = require("../server/logger");

const LOG_FILE = path.join(__dirname, "..", "logs", "loophole.csv");
const LOOPHOLE_BIN = path.join(
  __dirname,
  "..",
  "loophole-cli_1.0.0-beta.15_linux_64bit",
  "loophole"
);
const LOOPHOLE_ARGS = ["http", "3000", "--hostname", "barrierfree-map"];

// loophole CLI の標準出力・標準エラーをそのまま CSV ログへ保存する。
const logger = createLogger(LOG_FILE);
const { appendLog } = logger;

appendLog("INFO", "loophole_logger_start");

// 長時間起動するトンネルプロセスなので、出力はすべて pipe で監視する。
const child = spawn(LOOPHOLE_BIN, LOOPHOLE_ARGS, {
  stdio: ["ignore", "pipe", "pipe"],
});

const stdoutRl = readline.createInterface({ input: child.stdout });
stdoutRl.on("line", (line) => {
  // 正常系の通知や接続 URL は INFO として残す。
  appendLog("INFO", line);
  process.stdout.write(`${line}\n`);
});

const stderrRl = readline.createInterface({ input: child.stderr });
stderrRl.on("line", (line) => {
  // 異常系は ERROR として分けて保存し、端末にもそのまま流す。
  appendLog("ERROR", line);
  process.stderr.write(`${line}\n`);
});

child.on("exit", (code, signal) => {
  // 親プロセスも同じ終了コードで落とし、監視側から異常終了を検知しやすくする。
  appendLog("WARN", `loophole_exit code=${code ?? "null"} signal=${signal ?? "null"}`);
  process.exit(code ?? 1);
});
