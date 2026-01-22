function createRecordHandlers({ pool, sendJson }) {
  let hasSeqColumn = null;

  async function getSeqColumnState() {
    if (hasSeqColumn !== null) {
      return hasSeqColumn;
    }
    try {
      const rows = await pool.query("SHOW COLUMNS FROM session_points LIKE 'seq'");
      hasSeqColumn = Array.isArray(rows) && rows.length > 0;
    } catch {
      hasSeqColumn = false;
    }
    return hasSeqColumn;
  }

  function sendServerError(res) {
    sendJson(res, 500, { error: "server_error" });
  }

  function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) {
          reject(new Error("body_too_large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (!body) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("invalid_json"));
        }
      });
      req.on("error", reject);
    });
  }

  async function handleStart(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!pool) {
      sendServerError(res);
      return;
    }
    try {
      const payload = await parseJsonBody(req);
      const userId =
        typeof payload.userId === "string" && payload.userId.trim()
          ? payload.userId.trim()
          : "anonymous";
      const result = await pool.query(
        "INSERT INTO sessions (user_id, started_at) VALUES (?, NOW())",
        [userId]
      );
      sendJson(res, 200, { sessionId: result.insertId });
    } catch {
      sendServerError(res);
    }
  }

  async function handlePoint(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!pool) {
      sendServerError(res);
      return;
    }
    try {
      const payload = await parseJsonBody(req);
      const sessionId = Number.parseInt(payload.sessionId, 10);
      const lat = Number.parseFloat(payload.lat);
      const lng = Number.parseFloat(payload.lng);
      const seq = Number.parseInt(payload.seq, 10);

      if (!Number.isFinite(sessionId) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        sendJson(res, 400, { error: "invalid_payload" });
        return;
      }

      const useSeq = await getSeqColumnState();
      if (useSeq && Number.isFinite(seq)) {
        await pool.query(
          "INSERT INTO session_points (session_id, seq, lat, lng, created_at) VALUES (?, ?, ?, ?, NOW())",
          [sessionId, seq, lat, lng]
        );
      } else {
        await pool.query(
          "INSERT INTO session_points (session_id, lat, lng, created_at) VALUES (?, ?, ?, NOW())",
          [sessionId, lat, lng]
        );
      }
      sendJson(res, 200, { ok: true });
    } catch {
      sendServerError(res);
    }
  }

  async function handleStop(req, res) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!pool) {
      sendServerError(res);
      return;
    }
    try {
      const payload = await parseJsonBody(req);
      const sessionId = Number.parseInt(payload.sessionId, 10);
      if (!Number.isFinite(sessionId)) {
        sendJson(res, 400, { error: "invalid_payload" });
        return;
      }
      await pool.query("UPDATE sessions SET ended_at = NOW() WHERE id = ?", [sessionId]);
      sendJson(res, 200, { ok: true });
    } catch {
      sendServerError(res);
    }
  }

  return { handleStart, handlePoint, handleStop };
}

module.exports = createRecordHandlers;
