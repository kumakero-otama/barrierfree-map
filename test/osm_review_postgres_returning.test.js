"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sources = [
  "server/api/osm_changes.js",
  "server/osm/review_queue.js",
].map((file) => fs.readFileSync(path.join(root, file), "utf8"));

for (const source of sources) {
  const reviewEventInserts = source.match(/INSERT INTO osmchange\.review_events[\s\S]*?(?=`|;)/g) || [];
  for (const sql of reviewEventInserts) {
    assert.match(sql, /RETURNING event_id AS id/, "review event INSERT must name its PostgreSQL primary key");
  }
}

assert.match(sources[1], /RETURNING notification_id AS id/, "review notification INSERT must name its PostgreSQL primary key");
console.log("OSM review INSERT statements use explicit PostgreSQL RETURNING columns");
