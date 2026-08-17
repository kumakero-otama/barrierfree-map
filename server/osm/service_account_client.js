const { createOsmApiClient } = require("./osm_api_client");

function serviceAccountConfig() {
  const accessToken = String(process.env.OSM_SERVICE_ACCESS_TOKEN || "").trim();
  const displayName = String(process.env.OSM_SERVICE_ACCOUNT_NAME || "").trim();
  return {
    configured: Boolean(accessToken && displayName),
    accessToken,
    displayName,
  };
}

function createServiceAccountOsmClient() {
  const config = serviceAccountConfig();
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

module.exports = { serviceAccountConfig, createServiceAccountOsmClient };
