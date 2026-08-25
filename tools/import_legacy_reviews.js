"use strict";

const crypto = require("crypto");
const fs = require("fs");
const yaml = require("yaml");
const { Pool } = require("pg");

if (process.argv[2] !== "--input" || !process.argv[3] || process.argv[4] !== "--confirm-cloud-review-only") {
  throw new Error("usage: node tools/import_legacy_reviews.js --input <export.json> --confirm-cloud-review-only");
}

function uuidFor(prefix, digest) {
  const hex = crypto.createHash("sha256").update(`${prefix}:${digest}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][parseInt(hex[16], 16) % 4];
  return `${hex.slice(0,8).join("")}-${hex.slice(8,12).join("")}-${hex.slice(12,16).join("")}-${hex.slice(16,20).join("")}-${hex.slice(20).join("")}`;
}

async function run() {
  const payload = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  if (payload.format !== "stepby-legacy-review-v1" || !Array.isArray(payload.records)) throw new Error("invalid_legacy_export");
  if (payload.recordCount !== payload.records.length) throw new Error("legacy_export_count_mismatch");
  let poolOptions = { connectionString: process.env.DATABASE_URL, max: 1 };
  if (!process.env.DATABASE_URL) {
    const config = yaml.parse(fs.readFileSync(process.env.DB_CONFIG_PATH || "config.dev.yaml", "utf8")).db;
    poolOptions = { host: config.host, port: config.port || 5432, user: config.user, password: config.password,
      database: config.database, max: 1, ssl: config.ssl ? { rejectUnauthorized: false } : undefined };
  }
  const pool = new Pool(poolOptions);
  const client = await pool.connect();
  let inserted = 0, existing = 0, pending = 0, held = 0, rejected = 0;
  try {
    await client.query("BEGIN");
    for (const record of payload.records) {
      if (!/^[a-f0-9]{64}$/.test(record.sourceDigest)) throw new Error("invalid_source_digest");
      const recordId = uuidFor("record", record.sourceDigest), planId = uuidFor("plan", record.sourceDigest), reviewId = uuidFor("review", record.sourceDigest);
      const classification = record.isGuest ? "excluded_guest" : !record.pathGeoJson ? "needs_path_investigation"
        : Number(record.pathMeters) < 2 ? "too_short" : "ready_for_human_review";
      const status = classification === "ready_for_human_review" ? "pending" : classification === "excluded_guest" ? "rejected" : "held";
      const metadata = { ...record, classification, legacyNeedsRefit: true, accuracyAvailable: Boolean(record.accuracyAvailable) };
      const result = await client.query(`INSERT INTO osmchange.change_plans
        (plan_id,operation_type,created_by,summary,elements,client_context)
        VALUES($1,'merge',4,$2,'[]'::jsonb,$3::jsonb) ON CONFLICT(plan_id) DO NOTHING RETURNING plan_id`,
      [planId, `旧StepBy記録 ${record.startedAt || "日時不明"}（審査・再フィッティング待ち）`, JSON.stringify({
        previewOnly: true, osmWriteRequested: false, source: "legacy_readonly_export", legacyNeedsRefit: true,
        sourceDigest: record.sourceDigest, classification })]);
      if (!result.rowCount) { existing += 1; continue; }
      await client.query(`INSERT INTO osmchange.review_queue
        (review_id,record_id,plan_id,source_type,source_record_id,source_metadata,review_status,rejection_reason,admin_note)
        VALUES($1,$2,$3,'legacy_record',$4,$5::jsonb,$6,$7,$8)`, [reviewId, recordId, planId, record.sourceDigest,
        JSON.stringify(metadata), status, status === "rejected" ? "旧ゲスト記録はOSMへ公開しない" : null,
        status === "held" ? "経路なし、または短すぎるため要調査" : null]);
      await client.query(`INSERT INTO osmchange.review_events(review_id,event_type,details)
        VALUES($1,'legacy_imported',$2::jsonb)`, [reviewId, JSON.stringify({ classification, osmSent: false })]);
      inserted += 1;
      if (status === "pending") pending += 1; else if (status === "held") held += 1; else rejected += 1;
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({ inserted, existing, pending, held, rejected, osmSent: false }));
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); await pool.end(); }
}

run().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
