"use strict";

// 画面遷移中のGPS保存口が、所有者確認後に生座標だけを保存することを固定する。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.resolve(__dirname, "../server/api/session.js"), "utf8");

assert.match(source, /action === "point"[\s\S]{0,120}?handleSessionPoint/,
  "session dispatcher must expose the raw-point action");
assert.match(source, /resolveAuthenticatedUserId\(req, pool\)[\s\S]{0,700}?WHERE session_id=\? AND user_id=\?/,
  "raw-point writes must require authentication and record ownership");
assert.match(source, /INSERT INTO tactile\.gps_raw/,
  "raw-point writes must append to tactile.gps_raw");
assert.doesNotMatch(
  source.slice(source.indexOf("async function handleSessionPoint"), source.indexOf("async function handleSessionStart")),
  /gps_matched|Valhalla|\/locate/,
  "raw-point writes must not save fitted coordinates or invoke Valhalla"
);

console.log("session raw-point storage policy is covered");
