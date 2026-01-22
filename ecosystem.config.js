module.exports = {
  apps: [
    {
      name: "barrierfree-map-server",
      script: "server.js",
      interpreter: "node",
      cwd: __dirname,
      autorestart: true,
    },
    {
      name: "barrierfree-map-loophole",
      script: "loophole",
      args: ["http", "3000", "--hostname", "barrierfree-map"],
      cwd: "loophole-cli_1.0.0-beta.15_linux_64bit",
      autorestart: true,
    },
  ],
};
