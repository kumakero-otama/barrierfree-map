const { loadRoadInfoConfig } = require("../road_info_config");

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

    const roadInfoConfig = loadRoadInfoConfig();
    sendJson(res, 200, {
      serverMinIntervalMs: MIN_INTERVAL_MS,
      clientMinIntervalMs: CLIENT_MIN_INTERVAL_MS,
      roadInfoImageMaxBytes: roadInfoConfig.imageMaxBytes,
    });
  };
}

module.exports = createConfigHandler;
