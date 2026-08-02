// 本番と同じサーバー上で、安全に並行稼働させる開発API用PM2定義。
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
        EXPERIMENT_DB_CONFIG_PATH: `${__dirname}/config.experiment.dev.yaml`,
        CORS_ALLOWED_ORIGINS: "http://localhost:8000,http://127.0.0.1:8000,https://barrierfree-map.tail5de5e1.ts.net:10001",
      },
    },
  ],
};
