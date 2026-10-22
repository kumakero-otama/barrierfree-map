"use strict";

// 共通ガード通過後も管理ハンドラ側で認可結果を再確認し、単層依存を避ける。
function requireGuardedAdmin(req, res, sendJson) {
  if (req && req.stepByAdminAuthorized === true && req.authUserId) return true;
  sendJson(res, 403, { error: "admin_required", requestId: req && req.securityRequestId });
  return false;
}

module.exports = { requireGuardedAdmin };
