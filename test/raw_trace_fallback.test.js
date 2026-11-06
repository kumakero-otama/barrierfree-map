"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "../server/api/trace.js"), "utf8");
const changesSource = fs.readFileSync(path.join(__dirname, "../server/api/osm_changes.js"), "utf8");

assert.match(source, /source === "browser_raw"/,
  "the trace API must accept the browser raw-point fallback");
assert.match(source, /SELECT session_id FROM tactile\.sessions WHERE session_id = \? AND user_id = \?/,
  "raw fallback writes must verify record ownership");
assert.match(source, /persistSessionPath\(pool, sessionId, "browser_raw"/,
  "raw fallback must retain a drawable StepBy path");
assert.match(source, /DELETE FROM tactile\.gps_matched WHERE session_id = \?/,
  "raw fallback must not present unconfirmed points as matched points");
assert.match(source, /DELETE FROM tactile\.way_snapshots WHERE record_id = \?/,
  "raw fallback must not retain an OSM change snapshot");
assert.match(source, /matchingPending: true[\s\S]{0,100}?osmSent: false/,
  "raw fallback must be clearly marked as pending matching and never OSM-sent");
assert.match(changesSource, /url\.pathname === "\/api\/osm\/pending-review"/,
  "an eligible raw recording must have a review-queue endpoint");
assert.match(changesSource, /needsRefit: true[\s\S]{0,5000}?enqueueReview/,
  "raw recordings must enter review as refitting candidates rather than being sent directly");
assert.match(changesSource, /action === "refit"[\s\S]{0,900}?prepareReviewRefitPlan/,
  "administrators must be able to refit a raw recording before publication");
assert.match(changesSource, /freshReview\.source_type === "legacy_record" \|\| freshReview\.source_metadata\.needsRefit === true/,
  "approval must refit pending raw recordings against current OSM data");

console.log("raw trace fallback preserves recordings without creating OSM changes");
