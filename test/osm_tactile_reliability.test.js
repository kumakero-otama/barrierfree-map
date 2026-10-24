"use strict";

// 公共Overpassへの過剰な並行問い合わせと、重いクエリへの回帰を防ぐ。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.resolve(__dirname, "../server/api/osm_tactile.js"), "utf8");

assert.match(source, /req\.setTimeout\(30000/,
  "StepBy must wait longer than the 25-second Overpass query limit");
assert.match(source, /cached\.savedAt < 5 \* 60 \* 1000/,
  "OSM tactile results must be cached to suppress repeated reads");
assert.match(source, /const tryHost = \(index\)[\s\S]{0,900}?tryHost\(index \+ 1\)/,
  "Overpass mirrors must be attempted sequentially after failure");
assert.doesNotMatch(source, /OVERPASS_HOSTS\.forEach/,
  "one screen refresh must not fan out to every Overpass mirror at once");
assert.match(source, /\[out:json\]\[timeout:25\]\[bbox:\$\{bbox\}\]/,
  "each Overpass query must be spatially bounded once at the global level");
assert.match(source, /out meta geom qt;/,
  "Overpass output must retain ownership metadata while using faster quadtile ordering");
assert.doesNotMatch(source, /\[\"tactile_paving\"~[^\n]+\]\(\$\{bbox\}\)/,
  "selectors must reuse the global bbox instead of repeating it");

console.log("OSM tactile reads use bounded queries, quadtile output, sequential fallback, and cache");
