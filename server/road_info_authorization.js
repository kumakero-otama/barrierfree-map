// 道情報の表示状態を変更できる管理者は、環境変数で明示したGoogleアカウントだけに限定する。
function configuredAdminEmails(env = process.env) {
  const raw = String(env.ROAD_INFO_ADMIN_EMAILS || env.OSM_REVIEW_ADMIN_EMAIL || "");
  return [...new Set(raw.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean))];
}

async function isRoadInfoAdmin(conn, userId, env = process.env) {
  const emails = configuredAdminEmails(env);
  if (!Number.isInteger(Number(userId)) || Number(userId) <= 0 || emails.length < 1) {
    return false;
  }
  const placeholders = emails.map(() => "?").join(", ");
  const [rows] = await conn.query(
    `SELECT 1
       FROM login.user_auth_providers
      WHERE user_id = ?
        AND provider = 'google'
        AND LOWER(email) IN (${placeholders})
      LIMIT 1`,
    [Number(userId), ...emails]
  );
  return Array.isArray(rows) && rows.length > 0;
}

function isPointOwner(pointOwnerUserId, currentUserId) {
  const owner = Number(pointOwnerUserId);
  const current = Number(currentUserId);
  return Number.isInteger(owner) && owner > 0 && owner === current;
}

module.exports = { configuredAdminEmails, isRoadInfoAdmin, isPointOwner };
