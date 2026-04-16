const { extractBearerToken, verifyAccessToken } = require("./auth_token");

// Cookie ヘッダーを単純な連想配列へ変換し、セッション Cookie を取り出しやすくする。
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

// Bearer トークン認証を優先し、無ければセッション Cookie を使って現在ユーザーを解決する。
async function resolveAuthenticatedUserId(req, pool) {
  const bearerToken = extractBearerToken(req);
  if (bearerToken) {
    try {
      const verified = verifyAccessToken(bearerToken);
      if (verified && Number.isFinite(verified.userId) && verified.userId > 0) {
        // DB が無効な構成でも、トークン自体が正しければ呼び出し元へ userId を返せるようにする。
        if (!pool) {
          return verified.userId;
        }
        // 退会済み・無効化済みのユーザーを弾くため、実在確認を追加する。
        const [userRows] = await pool.query(
          `SELECT user_id
           FROM login.users
           WHERE user_id = ? AND is_active = true
           LIMIT 1`,
          [verified.userId]
        );
        if (Array.isArray(userRows) && userRows.length > 0) {
          return verified.userId;
        }
        return null;
      }
    } catch {
      return null;
    }
  }

  if (!pool) {
    return null;
  }

  const cookies = parseCookies(req && req.headers ? req.headers.cookie : "");
  const sessionId = cookies.session;
  if (!sessionId) {
    return null;
  }

  // セッションテーブル側では有効期限切れもここで除外する。
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
