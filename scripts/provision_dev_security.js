const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const target = path.resolve(__dirname, "..", "config.security.dev.json");
if (fs.existsSync(target)) {
  console.log("Development security configuration already exists.");
  process.exit(0);
}
const config = {
  accessTokenSecret: crypto.randomBytes(48).toString("base64url"),
  adminKey: crypto.randomBytes(32).toString("base64url"),
};
fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(target, 0o600);
console.log("Created development security configuration.");
