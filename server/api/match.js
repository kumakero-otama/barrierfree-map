function createMatchHandler({
  https,
  MAPBOX_TOKEN,
  MIN_INTERVAL_MS,
  MAX_MATCH_CALLS_PER_MONTH,
  lastRequestByIp,
  getCurrentMonth,
  getMonthlyCount,
  incrementMonthlyCount,
  sendJson,
}) {
  function sendNoContent(res) {
    res.writeHead(204);
    res.end();
  }

  return function handleMatch(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!MAPBOX_TOKEN) {
      sendJson(res, 500, { error: "missing_mapbox_token" });
      return;
    }
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const lat = parseFloat(url.searchParams.get("lat"));
    const lng = parseFloat(url.searchParams.get("lng"));

    const currentMonth = getCurrentMonth();
    const currentCount = getMonthlyCount(currentMonth);

    if (currentCount >= MAX_MATCH_CALLS_PER_MONTH) {
      sendNoContent(res);
      return;
    }
    const prevLat = parseFloat(url.searchParams.get("prevLat"));
    const prevLng = parseFloat(url.searchParams.get("prevLng"));

    const ip = req.socket.remoteAddress || "unknown";
    console.log(`raw_lat=${lat}, raw_lng=${lng}, ip=${ip}`);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      sendJson(res, 400, { error: "invalid_coordinates" });
      return;
    }

    const now = Date.now();
    const last = lastRequestByIp.get(ip) || 0;
    if (now - last < MIN_INTERVAL_MS) {
      sendJson(res, 429, { error: "rate_limited", retryAfterMs: MIN_INTERVAL_MS - (now - last) });
      return;
    }
    lastRequestByIp.set(ip, now);

    let coords;
    if (!Number.isFinite(prevLat) || !Number.isFinite(prevLng)) {
      // 初回リクエスト時は、同じ座標を2回送信して道路にスナップ
      coords = `${lng},${lat};${lng},${lat}`;
      console.log(`match request (first time): lat=${lat}, lng=${lng}`);
    } else {
      coords = `${prevLng},${prevLat};${lng},${lat}`;
      console.log(`match request: lat=${lat}, lng=${lng}, prevLat=${prevLat}, prevLng=${prevLng}`);
    }

    console.log(`send_lat=${lat}, send_lng=${lng}`);
    const matchUrl = new URL(
      `https://api.mapbox.com/matching/v5/mapbox/driving/${coords}`
    );
    matchUrl.searchParams.set("access_token", MAPBOX_TOKEN);
    matchUrl.searchParams.set("geometries", "geojson");
    matchUrl.searchParams.set("overview", "full");
    matchUrl.searchParams.set("steps", "false");
    matchUrl.searchParams.set("radiuses", "25;25");
    matchUrl.searchParams.set("tidy", "false");
    console.log(`mapbox_request_url=${matchUrl.toString()}`);

    incrementMonthlyCount(currentMonth);
    const newCount = getMonthlyCount(currentMonth);
    https
      .get(matchUrl, (apiRes) => {
        let body = "";
        apiRes.on("data", (chunk) => {
          body += chunk;
        });
        apiRes.on("end", () => {
          console.log(`mapbox_response_status=${apiRes.statusCode || 0}`);
          // mapbox_response_bodyログを削除（500バイト超のJSON出力によるI/O負荷削減）
          // console.log(`mapbox_response_body=${body}`);
          try {
            const data = JSON.parse(body);
            const tracepoints = Array.isArray(data.tracepoints) ? data.tracepoints : [];
            const lastPoint = tracepoints[tracepoints.length - 1];
          if (lastPoint && Array.isArray(lastPoint.location)) {
            const [snappedLng, snappedLat] = lastPoint.location;
            sendJson(res, 200, { lat: snappedLat, lng: snappedLng, count: newCount, month: currentMonth });
            return;
          }
        } catch {
          // fall through to fallback
        }
        sendNoContent(res);
      });
    })
    .on("error", (err) => {
      console.log(`mapbox_response_error=${err.message}`);
      sendNoContent(res);
    });
  };
}

module.exports = createMatchHandler;
