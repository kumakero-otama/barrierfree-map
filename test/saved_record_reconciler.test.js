"use strict";
const assert = require("assert");
const fs = require("fs");
const { startSavedRecordReconciler } = require("../server/osm/saved_record_reconciler");

async function main() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = new Map();
  let nextId = 0;
  global.setTimeout = (callback, delay) => {
    const handle = { id: ++nextId, unref() { this.unreferenced = true; } };
    timers.set(handle, { callback, delay });
    return handle;
  };
  global.clearTimeout = (handle) => timers.delete(handle);
  async function fireNext() {
    const entry = timers.entries().next().value;
    assert.ok(entry, "one scheduled retry must exist");
    timers.delete(entry[0]);
    await entry[1].callback();
  }
  const events = [];
  let failureAt = null;
  let releaseSchema;
  let schemaPause = null;
  const persisted = [{ notification_id: "notification-1", review_id: "review-1", recipient: "review@example.invalid" }];
  const pool = { async query(sql) {
    events.push("persisted-notification-scan");
    assert.match(sql, /JOIN osmchange\.review_queue/);
    assert.match(sql, /JOIN tactile\.sessions/);
    assert.match(sql, /s\.is_active AND q\.review_status='pending'/);
    assert.match(sql, /n\.attempt_count<5/);
    assert.match(sql, /n\.status='pending'.*n\.status='failed'/);
    assert.match(sql, /INTERVAL '5 minutes'/);
    assert.match(sql, /LIMIT 10/);
    if (failureAt === "scan") throw new Error("mock scan unavailable");
    return [persisted];
  } };
  const options = {
    pool, initialDelayMs: 5, intervalMs: 50,
    async ensureSchema() {
      events.push("schema");
      if (failureAt === "schema") throw new Error("mock schema unavailable");
      if (schemaPause) await schemaPause;
    },
    async recover(actualPool, opts) {
      assert.strictEqual(actualPool, pool);
      assert.deepEqual(opts, { apply: true });
      events.push("recover-persisted-records");
      if (failureAt === "recover") throw new Error("mock recovery failed");
      return { recovered: 1 };
    },
    async recoverReviews(actualPool, opts) {
      assert.strictEqual(actualPool, pool);
      assert.deepEqual(opts, { apply: true });
      events.push("recover-persisted-reviews");
      if (failureAt === "reviews") throw new Error("mock reviews failed");
      return { queued: 1 };
    },
    async deliverNotification(actualPool, notification) {
      assert.strictEqual(actualPool, pool);
      assert.deepEqual(notification, { notificationId: "notification-1", reviewId: "review-1", recipient: "review@example.invalid" });
      events.push("mail-retry");
      if (failureAt === "mail") throw new Error("mock mail unavailable");
    },
    log: { info() { events.push("info"); }, error() { events.push("retry-error"); } },
  };
  let worker;
  try {
    worker = startSavedRecordReconciler(options);
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].delay, 5);
    assert.equal([...timers.keys()][0].unreferenced, true);
    await fireNext();
    assert.deepEqual(events, ["schema", "recover-persisted-records", "recover-persisted-reviews", "persisted-notification-scan", "mail-retry", "info"]);
    assert.equal(timers.size, 1);
    assert.equal([...timers.values()][0].delay, 50);
    // Manual execution must replace its pending timer, not create another chain.
    await worker.run();
    assert.equal(timers.size, 1, "manual run must leave only one retry timer");
    for (const stage of ["schema", "recover", "reviews", "scan", "mail"]) {
      failureAt = stage;
      events.length = 0;
      await fireNext();
      assert.ok(events.includes("retry-error"), `${stage} failures must be caught`);
      assert.equal(timers.size, 1, `${stage} failures must reschedule`);
    }
    failureAt = null;
    events.length = 0;
    schemaPause = new Promise((resolve) => { releaseSchema = resolve; });
    const inFlight = worker.run();
    await worker.run();
    assert.deepEqual(events, ["schema"], "concurrent invocation must not start a second scan");
    worker.stop();
    assert.equal(timers.size, 0);
    releaseSchema();
    await inFlight;
    assert.equal(timers.size, 0, "stopping during execution must prevent rescheduling");
    events.length = 0;
    await worker.run();
    assert.deepEqual(events, [], "a stopped worker must not run again");
    // No OSM executor or HTTP dependency may be added to this DB/mail-only worker.
    const source = fs.readFileSync(require.resolve("../server/osm/saved_record_reconciler"), "utf8");
    assert.doesNotMatch(source, /require\s*\(|\bfetch\s*\(|\bexecuteWithClient\s*\(|\bserviceClientFactory\s*\(/);
    console.log("saved record reconciler persisted recovery, review/mail retries, timer lifecycle and no-OSM regressions passed");
  } finally {
    worker?.stop();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
