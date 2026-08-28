"use strict";

// 外部サービスへ書き込まない単体テストを、ファイル名順に一括実行する。
// 途中で1件でも失敗した場合は即座に非0で終了し、CIでも検知できるようにする。
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const testDir = path.resolve(__dirname, "..", "test");
const testFiles = fs.readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort();

for (const name of testFiles) {
  const result = spawnSync(process.execPath, [path.join(testDir, name)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`\n${testFiles.length}件の単体テストが成功しました。`);
