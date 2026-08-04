const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const target = path.resolve(__dirname, "..", "config.security.dev.json");
const config = fs.existsSync(target)
  ? JSON.parse(fs.readFileSync(target, "utf8"))
  : {};
config.accessTokenSecret = config.accessTokenSecret || crypto.randomBytes(48).toString("base64url");
config.adminKey = config.adminKey || crypto.randomBytes(32).toString("base64url");
config.osmTokenEncryptionKey = config.osmTokenEncryptionKey || crypto.randomBytes(48).toString("base64url");
fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(target, 0o600);
console.log("Development security configuration is ready.");
