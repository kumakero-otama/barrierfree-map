"use strict";

// 公共Overpassへの過剰な並行問い合わせと、早すぎる打切りの再発を防ぐ。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.resolve(__dirname, "../server/api/osm_tactile.js"), "utf8");

assert.match(source, /req\.setTimeout\(30000/,
  "StepBy must wait longer than the 25-second Overpass query limit");
assert.match(source, /FRESH_CACHE_MS = 30 \* 60 \* 1000/,
  "OSM tactile results must be cached for 30 minutes");
assert.match(source, /const tryHost = \(index\)[\s\S]{0,900}?tryHost\(index \+ 1\)/,
  "Overpass mirrors must be attempted sequentially after failure");
assert.doesNotMatch(source, /OVERPASS_HOSTS\.forEach/,
  "one screen refresh must not fan out to every Overpass mirror at once");

console.log("OSM tactile reads use sequential fallback, a 30-second timeout, and a longer cache");
