"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.resolve(__dirname, "../server/api/records.js"), "utf8");

assert.match(source, /COALESCE\(tag_info\.all_tags,\s*ARRAY\['点字ブロック'\]::text\[\]\)/,
  "untagged saved paths must remain visible to their owner as tactile paving");
assert.match(source, /COALESCE\(tag_info\.public_tags,\s*ARRAY\['点字ブロック'\]::text\[\]\)/,
  "untagged saved paths must remain visible to other users as tactile paving");
assert.match(source, /COALESCE\(tag_info\.all_tag_codes,\s*ARRAY\['tactile_paving'\]::text\[\]\)/,
  "untagged saved paths must expose the standard public tag code");

console.log("untagged saved tactile paths remain visible and future general-mode records get a standard tag");
