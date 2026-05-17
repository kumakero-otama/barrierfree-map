// PM2 で API サーバーをまとめて起動するための定義。
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
  ],
};
