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

const logger = createLogger(LOG_FILE);
const { appendLog } = logger;

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
