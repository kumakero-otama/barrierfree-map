const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "../server/api/tactile_tags.js"), "utf8");

assert.match(source, /CASE WHEN s\.user_id = \? THEN s\.memo ELSE NULL END AS memo/,
  "session detail SQL must not return another user's private memo");
assert.match(source, /\[req\.authUserId, sessionId\]/,
  "memo visibility must be decided from the authenticated StepBy user, not a client-supplied owner ID");

console.log("tactile memo privacy is enforced in the database query");
