"use strict";

const nodemailer = require("nodemailer");

const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "OSM_REVIEW_ADMIN_EMAIL"];
const missing = required.filter((name) => !String(process.env[name] || "").trim());
if (missing.length) {
  console.error(`Email configuration is missing: ${missing.join(", ")}`);
  process.exit(1);
}

const reviewUrl = String(
  process.env.OSM_REVIEW_URL
  || process.env.OSM_REVIEW_BASE_URL
  || "https://kumakero-otama.github.io/StepBy/UI11/admin/osm-review.html"
);
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

transport.sendMail({
  from: process.env.SMTP_FROM || process.env.SMTP_USER,
  to: process.env.OSM_REVIEW_ADMIN_EMAIL,
  subject: "[StepBy] OSM公開確認メールの送信テスト",
  text: `StepByの審査通知メール設定は正常です。\n\n審査画面: ${reviewUrl}\n`,
}).then((info) => {
  console.log(`Test email sent: ${info.messageId}`);
}).catch((error) => {
  console.error(`Test email failed: ${error.code || error.message}`);
  process.exitCode = 1;
});
