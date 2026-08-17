const assert = require("assert");
const fs = require("fs");
const path = require("path");

const detailSource = fs.readFileSync(path.join(__dirname, "../server/api/tactile_tags.js"), "utf8");
const recordsSource = fs.readFileSync(path.join(__dirname, "../server/api/records.js"), "utf8");
const plannerSource = fs.readFileSync(path.join(__dirname, "../server/osm/split_planner.js"), "utf8");

assert.match(detailSource, /WHEN s\.user_id = \? OR COALESCE\(t\.osm_exportable, FALSE\)[\s\S]*?THEN t\.label_ja[\s\S]*?ELSE NULL/,
  "session details must suppress private tag labels for non-owners in SQL");
assert.match(recordsSource, /CASE WHEN s\.user_id = \?[\s\S]*?tag_info\.all_tags[\s\S]*?tag_info\.public_tags/,
  "record lists must return every tag only to the owner");
assert.match(recordsSource, /FILTER \(WHERE t\.osm_exportable\) AS public_tags/,
  "record lists must expose only explicitly public tags to other users");
assert.match(plannerSource, /tags: \{ tactile_paving: tactileValue \}/,
  "independent walkway OSM edits must only add tactile_paving");
assert.match(plannerSource, /tags: \{ \[targetTagKey\]: tactileValue \}/,
  "roadway OSM edits must only add the side-specific tactile_paving tag");
assert.doesNotMatch(plannerSource, /grating|fence|waterway_cover|pro_note/,
  "private StepBy tag names must never enter the OSM split planner");

console.log("private PRO tags are owner-only and absent from OSM changes");
