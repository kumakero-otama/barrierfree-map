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

      console.log(`[Trace] Received ${requestData.shape?.length || 0} points`);

      const valhallaRequest = {
        shape: requestData.shape,
        costing: requestData.costing || "pedestrian",
        shape_match: requestData.shape_match || "map_snap",
        filters: requestData.filters || {
          attributes: ["shape"],
          action: "include"
        }
      };

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
          console.log(`[Trace] Valhalla response status: ${apiRes.statusCode}`);
          try {
            const data = JSON.parse(responseBody);
            console.log(`[Trace] Response: edges=${data.edges?.length || 0}, matched_points=${data.matched_points?.length || 0}`);
            sendJson(res, 200, data);
          } catch (err) {
            console.error("[Trace] Parse error:", err.message);
            sendJson(res, 500, { error: "valhalla_parse_error" });
          }
        });
      });

      valhallaReq.on("error", (err) => {
        console.error("[Trace] Request error:", err.message);
        sendJson(res, 500, { error: "valhalla_request_error", message: err.message });
      });

      valhallaReq.write(requestBody);
      valhallaReq.end();
    });
  };
}

module.exports = createTraceHandler;
