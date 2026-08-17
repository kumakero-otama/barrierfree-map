const assert = require("assert");
const createDevApiGuard = require("../server/security/dev_api_guard");

process.env.NODE_ENV = "development";
process.env.ACCESS_TOKEN_SECRET = "test-secret-at-least-thirty-two-characters";
process.env.DEV_ADMIN_KEY = "test-admin-key-at-least-thirty-two-characters";

function response() {
  return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead() {}, end() {} };
}

const guard = createDevApiGuard({
  sendJson(res, status, payload) { res.status = status; res.payload = payload; },
  logDir: "/tmp",
  allowedOrigins: ["https://kumakero-otama.github.io"],
  verifyAdminSession: () => true,
});
const sameOriginReq = {
  method: "GET", url: "/api/admin/osm-service-account/status",
  headers: { origin: "https://stepby-api.example", host: "127.0.0.1:3100", "x-forwarded-proto": "https", "x-forwarded-host": "stepby-api.example" },
  socket: { remoteAddress: "127.0.0.1" },
};
assert.strictEqual(guard(sameOriginReq, response()), true);
const foreignReq = { ...sameOriginReq, headers: { ...sameOriginReq.headers, origin: "https://evil.example" } };
const foreignRes = response();
assert.strictEqual(guard(foreignReq, foreignRes), false);
assert.strictEqual(foreignRes.status, 403);
assert.strictEqual(foreignRes.payload.error, "origin_not_allowed");
console.log("same-origin admin requests allowed; foreign origins rejected");
