const http = require("http");

function createTraceHandler({ sendJson }) {
  const VALHALLA_HOST = process.env.VALHALLA_HOST || "localhost";
  const VALHALLA_PORT = process.env.VALHALLA_PORT || "8002";

  return function handleTrace(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", () => {
      let requestData;
      try {
        requestData = JSON.parse(body);
      } catch (err) {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }

      const ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";
      const userId = requestData.userId || "unknown";
      const logPrefix = `[Trace][User:${userId} / IP:${ip}]`;
      console.log(`${logPrefix} Received ${requestData.shape?.length || 0} points`);

      const valhallaRequest = {
        shape: requestData.shape,
        costing: requestData.costing || "pedestrian",
        shape_match: requestData.shape_match || "map_snap"
      };

      // クライアントからの明示的なフィルタがあればそれを使う。
      // なければフィルタを設定せず、Valhallaのデフォルト（全ての属性）を返すようにする。
      if (requestData.filters) {
        valhallaRequest.filters = requestData.filters;
      }

      const requestBody = JSON.stringify(valhallaRequest);

      const options = {
        hostname: VALHALLA_HOST,
        port: VALHALLA_PORT,
        path: "/trace_attributes",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody)
        }
      };

      const valhallaReq = http.request(options, (apiRes) => {
        let responseBody = "";
        apiRes.on("data", (chunk) => {
          responseBody += chunk;
        });
        apiRes.on("end", () => {
          console.log(`${logPrefix} Valhalla response status: ${apiRes.statusCode}`);
          try {
            const data = JSON.parse(responseBody);
            console.log(`${logPrefix} Response: edges=${data.edges?.length || 0}, matched_points=${data.matched_points?.length || 0}`);
            sendJson(res, 200, data);
          } catch (err) {
            console.error(`${logPrefix} Parse error:`, err.message);
            sendJson(res, 500, { error: "valhalla_parse_error" });
          }
        });
      });

      valhallaReq.on("error", (err) => {
        console.error(`${logPrefix} Request error:`, err.message);
        sendJson(res, 500, { error: "valhalla_request_error", message: err.message });
      });

      valhallaReq.write(requestBody);
      valhallaReq.end();
    });
  };
}

module.exports = createTraceHandler;
