"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "../server/api/osm_changes.js"), "utf8");

assert.match(source, /if \(action === "refit"\)/, "管理者向け再マップマッチングAPIが必要");
assert.match(source, /\{ previewOnly: true \}/, "再マップマッチング単体操作はOSMへ送信しない");
assert.match(source, /osmWriteRequested: !previewOnly/, "再作成した変更案に送信意図を正しく記録する");
assert.match(source, /review\.review_status === "merged"/, "OSM公開済みの記録を再マップマッチングしない");
assert.match(source, /legacy_refit_plan_created/, "再作成した変更案を追記監査する");

console.log("OSM review refit endpoint remains preview-only and audited");
