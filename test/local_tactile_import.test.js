"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.resolve(__dirname, "../scripts/import_local_tactile_tiles.js"),
  "utf8"
);

assert.match(source, /formatVersion !== 1/, "seed format must be versioned");
assert.match(source, /tiles\.length > 5000/, "seed tile count must be bounded");
assert.match(source, /if \(!apply\) process\.exit\(0\)/,
  "import must validate without mutating unless --apply is explicit");
assert.match(source, /await connection\.beginTransaction\(\)/,
  "snapshot replacement must be transactional");
assert.match(source, /DELETE FROM osmcache\.local_tactile_tiles WHERE snapshot_id<>\?/,
  "obsolete snapshot rows must be removed only inside the replacement transaction");
assert.doesNotMatch(source, /(access_token|password|cookie)/i,
  "the public local snapshot importer must not process secrets");

console.log("local tactile snapshot import is bounded, explicit, and transactional");
