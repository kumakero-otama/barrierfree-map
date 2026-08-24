"use strict";

const nodemailer = require("nodemailer");

const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"];
const missing = required.filter((name) => !String(process.env[name] || "").trim());

if (missing.length) {
  console.error(`SMTP configuration is missing: ${missing.join(", ")}`);
  process.exit(1);
}

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transport.verify()
  .then(() => {
    console.log("SMTP authentication verified. No email was sent.");
  })
  .catch((error) => {
    const detail = error.response || error.message || error.code || "unknown error";
    console.error(`SMTP verification failed: ${error.code || "ERROR"}: ${detail}`);
    process.exitCode = 1;
  });
