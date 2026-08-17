const { createOsmApiClient } = require("./osm_api_client");
const { loadStoredServiceAccount } = require("./service_account_store");

function serviceAccountConfig() {
  const accessToken = String(process.env.OSM_SERVICE_ACCESS_TOKEN || "").trim();
  const displayName = String(process.env.OSM_SERVICE_ACCOUNT_NAME || "").trim();
  return {
    configured: Boolean(accessToken && displayName),
    accessToken,
    displayName,
  };
}

async function resolvedServiceAccountConfig() {
  // 管理画面で明示的に認証したStepBy専用アカウントを最優先する。
  // 環境変数は初期導入時のフォールバックに限定し、過去の個人トークンが
  // 残っていても編集主体を上書きしない。
  const stored = await loadStoredServiceAccount();
  if (stored) return { configured: true, ...stored, source: "database" };
  const config = serviceAccountConfig();
  return { ...config, source: config.configured ? "environment" : null };
}

async function createServiceAccountOsmClient() {
  const config = await resolvedServiceAccountConfig();
  if (!config.configured) {
    const error = new Error("osm_service_account_not_configured");
    error.status = 503;
    throw error;
  }
  return createOsmApiClient({
    baseUrl: process.env.OSM_API_BASE_URL,
    accessToken: config.accessToken,
  });
}

module.exports = { serviceAccountConfig, resolvedServiceAccountConfig, createServiceAccountOsmClient };
