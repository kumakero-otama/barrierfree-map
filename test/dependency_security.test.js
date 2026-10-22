"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8"));
assert.strictEqual(lock.packages["node_modules/nodemailer"].version, "10.2.0");
assert.strictEqual(lock.packages["node_modules/brace-expansion"].version, "2.1.7");

(async () => {
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const result = await transport.sendMail({
    from: "stepby@example.invalid",
    to: "admin@example.invalid",
    subject: "security dependency regression test",
    text: "No network delivery is performed.",
  });
  assert.ok(result.message);
  console.log("patched dependency versions and Nodemailer 10 API compatibility verified without network delivery");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
