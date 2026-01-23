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
      script: "scripts/loophole_logger.js",
      interpreter: "node",
      cwd: __dirname,
      autorestart: true,
    },
  ],
};
