// 本番と同じサーバー上で、安全に並行稼働させる開発API用PM2定義。
const fs = require("fs");
const path = require("path");
const securityConfigPath = path.join(__dirname, "config.security.dev.json");
const securityConfig = fs.existsSync(securityConfigPath)
  ? JSON.parse(fs.readFileSync(securityConfigPath, "utf8"))
  : {};

module.exports = {
  apps: [
    {
      name: "barrierfree-map-dev",
      script: "server.js",
      interpreter: "node",
      cwd: __dirname,
      autorestart: true,
      env: {
        NODE_ENV: "development",
        HTTP_HOST: "127.0.0.1",
        HTTP_PORT: "3100",
        HTTPS_PORT: "3101",
        DB_CONFIG_PATH: `${__dirname}/config.dev.yaml`,
        // UI10の通常データと比較履歴は、同じ隔離済み開発DB内の別スキーマへ保存する。
        EXPERIMENT_DB_CONFIG_PATH: `${__dirname}/config.dev.yaml`,
        ACCESS_TOKEN_SECRET: securityConfig.accessTokenSecret || "",
        DEV_ADMIN_KEY: securityConfig.adminKey || "",
        OSM_TOKEN_ENCRYPTION_KEY: securityConfig.osmTokenEncryptionKey || "",
        // StepBy専用OSMアカウントのトークンはSecret Manager等から注入する。リポジトリへ書かない。
        OSM_SERVICE_ACCESS_TOKEN: process.env.OSM_SERVICE_ACCESS_TOKEN || "",
        OSM_SERVICE_ACCOUNT_NAME: process.env.OSM_SERVICE_ACCOUNT_NAME || "",
        OSM_WRITES_ENABLED: process.env.OSM_WRITES_ENABLED || "false",
        OSM_COMMUNITY_APPROVED: process.env.OSM_COMMUNITY_APPROVED || "false",
        OSM_AUTOMATED_EDIT_WIKI_URL: process.env.OSM_AUTOMATED_EDIT_WIKI_URL || "",
        OSM_CHANGESET_HASHTAG: process.env.OSM_CHANGESET_HASHTAG || "#StepBy",
        OSM_AUTOMATED_EDIT_TAG: process.env.OSM_AUTOMATED_EDIT_TAG || "mechanical",
        OSM_OAUTH_CLIENT_ID: process.env.OSM_OAUTH_CLIENT_ID || "_RNQ6UvXPuMlFGpp0NplFL36rspwWezbdUxs72Spe30",
        OSM_OAUTH_CLIENT_SECRET: process.env.OSM_OAUTH_CLIENT_SECRET || "",
        OSM_OAUTH_REDIRECT_URI: process.env.OSM_OAUTH_REDIRECT_URI || "https://barrierfree-map.tail5de5e1.ts.net:10000/auth/osm/callback",
        OSM_OAUTH_FRONTEND_RETURN_URL: process.env.OSM_OAUTH_FRONTEND_RETURN_URL || "https://kumakero-otama.github.io/StepBy/UI10/profile/Index.html",
        OSM_OAUTH_AUTHORIZE_URL: process.env.OSM_OAUTH_AUTHORIZE_URL || "https://master.apis.dev.openstreetmap.org/oauth2/authorize",
        OSM_OAUTH_TOKEN_URL: process.env.OSM_OAUTH_TOKEN_URL || "https://master.apis.dev.openstreetmap.org/oauth2/token",
        OSM_USER_DETAILS_URL: process.env.OSM_USER_DETAILS_URL || "https://master.apis.dev.openstreetmap.org/api/0.6/user/details.json",
        CORS_ALLOWED_ORIGINS: "http://localhost:8000,http://127.0.0.1:8000,https://barrierfree-map.tail5de5e1.ts.net,https://barrierfree-map.tail5de5e1.ts.net:10001,https://kumakero-otama.github.io",
      },
    },
  ],
};
