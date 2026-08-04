const assert = require("assert");

// OAuth実送信をせず、サーバーファイルが読み込み可能であることと公開API形だけを確認する。
const createOsmOAuthHandler = require("../server/api/osm_oauth");

assert.strictEqual(typeof createOsmOAuthHandler, "function");
console.log("osm_oauth_helpers.test: ok");
