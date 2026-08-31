"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");

assert.match(source, /const CRUD_LOG = path\.join\(LOG_DIR, "crud\.csv"\)/,
  "CRUD監視は専用ログへ保存する");
assert.match(source, /GET: "READ", POST: "CREATE", PUT: "UPDATE", PATCH: "UPDATE", DELETE: "DELETE"/,
  "HTTPメソッドをCRUD分類として記録する");
assert.match(source, /requestId[\s\S]{0,260}?operation[\s\S]{0,220}?status[\s\S]{0,120}?durationMs/,
  "ログには追跡ID・処理種別・結果・所要時間を含める");
assert.doesNotMatch(source.slice(source.indexOf("function attachCrudLog"), source.indexOf("function getCurrentMonth")),
  /requestRawBody|authorization|cookie|coordinates|latitude|longitude/,
  "CRUDログに本文・認証情報・座標を保存しない");

console.log("CRUD request logging policy is covered without external communication");
