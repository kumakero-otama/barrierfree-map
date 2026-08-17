const assert = require("assert");

process.env.OSM_TOKEN_ENCRYPTION_KEY = "test-only-key-never-used-outside-this-process";
const { encrypt, decrypt } = require("../server/osm/service_account_store");

const token = "test-oauth-token-never-sent";
const encryptedA = encrypt(token);
const encryptedB = encrypt(token);
assert.notStrictEqual(encryptedA, token);
assert.notStrictEqual(encryptedA, encryptedB, "random IV must produce different ciphertext");
assert.strictEqual(decrypt(encryptedA), token);
assert.strictEqual(decrypt(encryptedB), token);
console.log("OSM service token encryption test passed without network access");
