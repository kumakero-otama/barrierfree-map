"use strict";

// 公共Overpassへの過剰な並行問い合わせと、重いクエリへの回帰を防ぐ。
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.resolve(__dirname, "../server/api/osm_tactile.js"), "utf8");

assert.match(source, /OVERPASS_REQUEST_TIMEOUT_MS = 12000/,
  "a congested Overpass host must not block the UI for 30 seconds");
assert.match(source, /CACHE_FRESH_MS = 30 \* 60 \* 1000/,
  "fresh OSM tactile results must be reused to suppress repeated reads");
assert.match(source, /CACHE_STALE_MS = 24 \* 60 \* 60 \* 1000/,
  "recent stale data must be available while Overpass refreshes in the background");
assert.match(source, /const inFlightRequests = new Map\(\)/,
  "duplicate requests for the same area must be coalesced");
assert.match(source, /HOST_FAILURE_COOLDOWN_MS = 2 \* 60 \* 1000/,
  "recently failed mirrors must be skipped briefly");
assert.doesNotMatch(source, /["']overpass\.kumi\.systems["']/,
  "the retired kumi hostname must not duplicate the private.coffee backend");
assert.match(source, /process\.env\.OVERPASS_HOST/,
  "an explicitly configured Overpass host must remain supported");
assert.match(source, /const tryHost = \(index\)[\s\S]{0,900}?tryHost\(index \+ 1\)/,
  "Overpass mirrors must be attempted sequentially after failure");
assert.doesNotMatch(source, /OVERPASS_HOSTS\.forEach/,
  "one screen refresh must not fan out to every Overpass mirror at once");
assert.match(source, /\[out:json\]\[timeout:\$\{OVERPASS_QUERY_TIMEOUT_SECONDS\}\]\[bbox:\$\{bbox\}\]/,
  "each Overpass query must be spatially bounded once at the global level");
assert.match(source, /out meta geom qt;/,
  "Overpass output must retain ownership metadata while using faster quadtile ordering");
assert.doesNotMatch(source, /\[\"tactile_paving\"~[^\n]+\]\(\$\{bbox\}\)/,
  "selectors must reuse the global bbox instead of repeating it");

console.log("OSM tactile reads use bounded queries, quadtile output, sequential fallback, and cache");
