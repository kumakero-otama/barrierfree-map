function createConfigHandler({
  MIN_INTERVAL_MS,
  CLIENT_MIN_INTERVAL_MS,
  sendJson,
}) {
  return function handleConfig(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    sendJson(res, 200, {
      serverMinIntervalMs: MIN_INTERVAL_MS,
      clientMinIntervalMs: CLIENT_MIN_INTERVAL_MS,
    });
  };
}

module.exports = createConfigHandler;
