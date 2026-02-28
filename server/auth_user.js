function parseCookies(rawCookieHeader) {
  const cookieHeader = rawCookieHeader || "";
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) {
        return acc;
      }
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

async function resolveAuthenticatedUserId(req, pool) {
  if (!pool) {
    return null;
  }
  const cookies = parseCookies(req && req.headers ? req.headers.cookie : "");
  const sessionId = cookies.session;
  if (!sessionId) {
    return null;
  }

  const [rows] = await pool.query(
    `SELECT user_id
     FROM login.user_sessions
     WHERE session_id = ?
       AND expires_at > CURRENT_TIMESTAMP
     LIMIT 1`,
    [sessionId]
  );

  if (!Array.isArray(rows) || rows.length < 1) {
    return null;
  }
  const userId = Number(rows[0].user_id);
  if (!Number.isFinite(userId) || userId <= 0) {
    return null;
  }
  return userId;
}

module.exports = {
  resolveAuthenticatedUserId,
};
