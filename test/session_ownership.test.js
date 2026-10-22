"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");

const dbPath = require.resolve("../server/db");
const authPath = require.resolve("../server/auth_user");
const loggerPath = require.resolve("../server/logger");
const sessionPath = require.resolve("../server/api/session");

let queryResult = [{ affectedRows: 1, rowCount: 1 }];
let transactionSelectRows = [];
let transactionMutationAffectedRows = 1;
const queries = [];
const transactionQueries = [];
const pool = {
  async query(sql, params) {
    queries.push({ sql, params });
    return queryResult;
  },
  async getConnection() {
    return {
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
      release() {},
      async query(sql, params) {
        transactionQueries.push({ sql, params });
        if (/^SELECT session_id, user_id/.test(sql)) return [transactionSelectRows];
        return [{ affectedRows: transactionMutationAffectedRows, rowCount: transactionMutationAffectedRows }];
      },
    };
  },
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { createDbPool: () => ({ pool, error: null }) },
};
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: { resolveAuthenticatedUserId: async (req) => req.authUserId },
};
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: { createLogger: () => ({ appendLog() {} }) },
};
delete require.cache[sessionPath];
const createSessionHandler = require(sessionPath);

const deletedSessionKeys = new Set();
const canceledSessionIds = new Set();
const handler = createSessionHandler({
  sendJson(res, status, body) {
    res.status = status;
    res.body = body;
    res.done();
  },
  deletedSessionKeys,
  canceledSessionIds,
});

function request(action, body, userId = 101) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = "POST";
    req.url = `/api/session/${action}`;
    req.headers = { host: "localhost" };
    req.authUserId = userId;
    const res = { done: () => resolve(res) };
    Promise.resolve(handler(req, res)).catch(reject);
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
}

(async () => {
  const sessionId = "123e4567-e89b-12d3-a456-426614174000";

  queries.length = 0;
  for (const action of ["start", "end", "cancel", "deactivate", "memo"]) {
    const invalid = await request(action, { sessionId: "not-a-uuid", memo: "test" });
    assert.strictEqual(invalid.status, 400, `${action} rejects a malformed UUID`);
    assert.strictEqual(invalid.body.error, "invalid_session_id");
  }
  assert.strictEqual(queries.length, 0, "invalid UUID must not reach PostgreSQL");

  queries.length = 0;
  queryResult = [{ affectedRows: 1, rowCount: 1 }];
  const ownRetry = await request("start", { sessionId, startedAt: "2026-10-22T00:00:00.000Z" });
  assert.strictEqual(ownRetry.status, 200, "same-owner retry remains idempotent");
  assert.strictEqual(queries.length, 1);
  assert.match(queries[0].sql, /WHERE tactile\.sessions\.user_id = EXCLUDED\.user_id/);
  assert.doesNotMatch(queries[0].sql, /SET\s+user_id\s*=/, "upsert must never replace the owner");

  queries.length = 0;
  queryResult = [{ affectedRows: 0, rowCount: 0 }];
  const collision = await request("start", { sessionId });
  assert.strictEqual(collision.status, 409);
  assert.strictEqual(collision.body.error, "session_id_conflict");

  queries.length = 0;
  queryResult = [{ affectedRows: 0, rowCount: 0 }];
  const foreignOwnerEnd = await request("end", { sessionId });
  assert.strictEqual(foreignOwnerEnd.status, 404);
  assert.strictEqual(foreignOwnerEnd.body.error, "session_not_found_or_forbidden");
  assert.match(queries[0].sql, /session_id = \? AND user_id = \?/);

  queries.length = 0;
  queryResult = [{ affectedRows: 0, rowCount: 0 }];
  const foreignOwnerMemo = await request("memo", { sessionId, memo: "not allowed" });
  assert.strictEqual(foreignOwnerMemo.status, 404);
  assert.match(queries[0].sql, /session_id = \? AND user_id = \?/);

  transactionQueries.length = 0;
  transactionMutationAffectedRows = 0;
  const foreignOwnerDeactivate = await request("deactivate", { sessionId });
  assert.strictEqual(foreignOwnerDeactivate.status, 404);
  assert.match(transactionQueries[0].sql, /session_id = \? AND user_id = \?/);

  transactionQueries.length = 0;
  transactionSelectRows = [];
  transactionMutationAffectedRows = 1;
  const foreignOwnerCancel = await request("cancel", { sessionId });
  assert.strictEqual(foreignOwnerCancel.status, 404);
  assert.strictEqual(canceledSessionIds.has(sessionId), false,
    "an unowned session ID must not poison the canceled-session cache");
  assert.strictEqual(deletedSessionKeys.has(`${sessionId}:101`), false);
  assert.match(transactionQueries[0].sql, /user_id = \? .*FOR UPDATE/);

  transactionQueries.length = 0;
  transactionSelectRows = [{ session_id: sessionId, user_id: 101 }];
  const ownCancel = await request("cancel", { sessionId });
  assert.strictEqual(ownCancel.status, 200);
  const sessionDelete = transactionQueries.find(({ sql }) => /^DELETE FROM tactile\.sessions/.test(sql));
  assert.ok(sessionDelete, "owned cancel deletes the session row");
  assert.match(sessionDelete.sql, /session_id = \? AND user_id = \?/,
    "final session delete must retain the owner condition");

  console.log("session UUID and ownership protections verified");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
