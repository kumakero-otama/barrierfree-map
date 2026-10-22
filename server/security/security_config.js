"use strict";

const MIN_SECRET_LENGTH = 32;

function validateSecret(env, name) {
  const value = String(env[name] || "");
  if (!value) throw new Error(`security_configuration_error:${name}_missing`);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`security_configuration_error:${name}_too_short`);
  }
  return value;
}

// 認証・管理APIに必要な秘密情報を起動前に検証する。値そのものはログへ出さない。
function assertSecurityConfiguration(env = process.env) {
  return {
    accessTokenSecret: validateSecret(env, "ACCESS_TOKEN_SECRET"),
    adminKey: validateSecret(env, "DEV_ADMIN_KEY"),
  };
}

module.exports = { MIN_SECRET_LENGTH, assertSecurityConfiguration };
