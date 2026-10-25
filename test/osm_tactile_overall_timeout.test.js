"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const https = require("https");
const { fetchOverpass } = require("../server/api/osm_tactile");

const originalRequest = https.request;
const request = new EventEmitter();
request.setTimeout = () => {};
request.write = () => {};
request.end = () => {};
request.destroy = (error) => setImmediate(() => request.emit("error", error));
https.request = () => request;

let callbackCount = 0;
const startedAt = Date.now();
fetchOverpass("example.invalid", "[out:json];out;", (error) => {
  callbackCount += 1;
  assert(error);
  assert.strictEqual(error.message, "overpass_timeout");
}, 20);

setTimeout(() => {
  try {
    assert.strictEqual(callbackCount, 1, "overall timeout and request error must share one callback");
    assert(Date.now() - startedAt < 150, "overall timeout must not wait for socket establishment");
    console.log("OSM tactile overall deadline fires once before socket establishment completes");
  } finally {
    https.request = originalRequest;
  }
}, 60);
