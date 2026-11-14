"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const { BoundedCache } = require("../server/bounded_cache");

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const createCache = (options = {}) => new BoundedCache({
  maxEntries: 3,
  maxBytes: 1024,
  ttlMs: 100,
  ...options,
});

// Map-compatible operations and replacement accounting, including UTF-8 bytes.
{
  const cache = createCache();
  assert.ok(cache instanceof Map);
  const first = { text: "歩道" };
  assert.strictEqual(cache.set("a", first), cache);
  assert.strictEqual(cache.get("a"), first);
  assert.strictEqual(cache.size, 1);
  assert.strictEqual(cache.byteSize, bytes(first));
  cache.set("a", "replacement");
  assert.strictEqual(cache.size, 1);
  assert.strictEqual(cache.byteSize, bytes("replacement"));
  assert.strictEqual(cache.delete("missing"), false);
  assert.strictEqual(cache.delete("a"), true);
  assert.strictEqual(cache.byteSize, 0);
  assert.strictEqual(cache.size, 0);
}

// A successful get refreshes recency; a miss does not affect eviction order.
{
  const cache = createCache({ maxEntries: 2 });
  cache.set("a", 1).set("b", 2);
  cache.get("a");
  assert.strictEqual(cache.get("missing"), undefined);
  cache.set("c", 3);
  assert.strictEqual(cache.get("b"), undefined);
  assert.strictEqual(cache.get("a"), 1);
  assert.strictEqual(cache.get("c"), 3);
  assert.strictEqual(cache.size, 2);
  assert.strictEqual(cache.byteSize, bytes(1) + bytes(3));
}

// The byte budget independently evicts the least recently used entries.
{
  const cache = createCache({ maxEntries: 10, maxBytes: 10 });
  cache.set("a", "aaa").set("b", "bbb");
  assert.strictEqual(cache.byteSize, 10);
  cache.get("a");
  cache.set("c", "cccc");
  assert.strictEqual(cache.get("a"), undefined);
  assert.strictEqual(cache.get("b"), undefined);
  assert.strictEqual(cache.get("c"), "cccc");
  assert.strictEqual(cache.byteSize, 6);
  cache.set("too-large", "123456789");
  assert.strictEqual(cache.get("too-large"), undefined);
  assert.strictEqual(cache.get("c"), "cccc");
  assert.strictEqual(cache.byteSize, 6);
}

// Expiry is measured from insertion, not last access, with an exact boundary.
{
  let now = 0;
  const cache = createCache({ now: () => now });
  cache.set("a", { value: 1 });
  now = 99;
  assert.deepStrictEqual(cache.get("a"), { value: 1 });
  now = 100;
  assert.strictEqual(cache.get("a"), undefined);
  assert.strictEqual(cache.size, 0);
  assert.strictEqual(cache.byteSize, 0);

  cache.set("a", "old");
  now = 150;
  cache.set("a", "new");
  now = 200;
  assert.strictEqual(cache.get("a"), "new");
  now = 250;
  assert.strictEqual(cache.get("a"), undefined);
}

// Sweep removes expired entries even if they are never requested again.
{
  let now = 0;
  const cache = createCache({ now: () => now });
  cache.set("old", "expired");
  now = 50;
  cache.set("fresh", "retained");
  now = 100;
  cache.sweep();
  assert.strictEqual(cache.size, 1);
  assert.strictEqual(cache.byteSize, bytes("retained"));
  assert.strictEqual(cache.get("old"), undefined);
  assert.strictEqual(cache.get("fresh"), "retained");
  cache.clear();
  assert.strictEqual(cache.size, 0);
  assert.strictEqual(cache.byteSize, 0);
  cache.set("after-clear", 42);
  assert.strictEqual(cache.get("after-clear"), 42);
  assert.strictEqual(cache.byteSize, bytes(42));
  now = 200;
  cache.sweep();
  assert.strictEqual(cache.byteSize, 0);
}

// A populated cache's cleanup timer must not keep a standalone process alive.
{
  const modulePath = require.resolve("../server/bounded_cache");
  const result = spawnSync(process.execPath, ["-e", `
    const { BoundedCache } = require(${JSON.stringify(modulePath)});
    new BoundedCache({ maxEntries: 2, maxBytes: 100, ttlMs: 60000 }).set('a', 1);
  `], { timeout: 5000, encoding: "utf8" });
  assert.ifError(result.error);
  assert.strictEqual(result.status, 0, result.stderr);
}

console.log("bounded cache tests passed");
