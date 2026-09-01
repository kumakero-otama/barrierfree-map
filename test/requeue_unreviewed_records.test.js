"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { parseArguments } = require("../tools/requeue_unreviewed_records");

assert.deepStrictEqual(
  parseArguments(["--record-id", "one", "--record-id", "one", "--record-id", "two", "--apply"]),
  { apply: true, recordIds: ["one", "two"] }
);
const source = fs.readFileSync(path.resolve(__dirname, "../tools/requeue_unreviewed_records.js"), "utf8");
assert.match(source, /if \(!apply\) return \{ recordId, dryRun: true/,
  "復旧ツールは既定で読み取り専用にする");
assert.match(source, /split_plan_backfilled_after_policy_update/,
  "復旧による変更案作成も追記型監査へ残す");
assert.doesNotMatch(source, /openstreetmap\.org|uploadChangeset|executePlan/,
  "復旧ツールからOSM送信を実行しない");

console.log("unreviewed record requeue tool is dry-run by default and never sends to OSM");
