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
  const config = serviceAccountConfig();
  if (config.configured) return config;
  const stored = await loadStoredServiceAccount();
  return stored ? { configured: true, ...stored } : config;
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
