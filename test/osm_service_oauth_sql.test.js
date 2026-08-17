const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "../server/api/osm_oauth.js"), "utf8");
const serviceInserts = [...source.matchAll(/INSERT INTO login\.osm_service[\s\S]*?(?=`[,)]|",)/g)].map((match) => match[0]);
assert.ok(serviceInserts.length >= 6, "service OAuth inserts should be covered");
for (const sql of serviceInserts) {
  assert.match(sql, /RETURNING\s+(state_hash|audit_id|singleton)/i,
    "every service OAuth insert must name a real RETURNING column for PgCompat");
}
console.log("OSM service OAuth SQL uses explicit PostgreSQL RETURNING columns");
