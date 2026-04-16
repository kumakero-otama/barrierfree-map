// PM2 で API サーバーと補助プロセスをまとめて起動するための定義。
module.exports = {
  apps: [
    {
      name: "barrierfree-map-server",
      script: "server.js",
      interpreter: "node",
      cwd: __dirname,
      autorestart: true,
      env_file: ".env", // .envファイルから環境変数を読み込む
    },
    {
      name: "barrierfree-map-loophole",
      script: "scripts/loophole_logger.js",
      interpreter: "node",
      cwd: __dirname,
      autorestart: true,
      env_file: ".env", // .envファイルから環境変数を読み込む
    },
  ],
};
