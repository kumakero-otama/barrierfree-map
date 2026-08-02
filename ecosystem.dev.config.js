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
        CORS_ALLOWED_ORIGINS: "http://localhost:8000,http://127.0.0.1:8000,https://barrierfree-map.tail5de5e1.ts.net:10001,https://kumakero-otama.github.io",
      },
    },
  ],
};
