// 端末側の変更案作成が途切れても、保存済みの対象記録をDBから回収する。
// OSMクライアントは呼ばず、確認待ち登録と通知の再試行だけを行う。
function startSavedRecordReconciler({ pool, ensureSchema, recover, recoverReviews, deliverNotification,
  intervalMs = 60000, initialDelayMs = 5000, log = console }) {
  let running = false;
  let stopped = false;
  let firstCycle = true;
  let timer;
  async function run() {
    if (running || stopped) return;
    clearTimeout(timer);
    running = true;
    try {
      await ensureSchema();
      const tags = await recover(pool, { apply: true });
      const reviews = await recoverReviews(pool, { apply: true });
      const [pending] = await pool.query(`SELECT n.notification_id,n.review_id,n.recipient
        FROM osmchange.review_notifications n JOIN osmchange.review_queue q USING(review_id)
        JOIN tactile.sessions s ON s.session_id=q.record_id
        WHERE s.is_active AND q.review_status='pending' AND n.attempt_count<5
          AND (n.status='pending' OR (n.status='failed' AND n.updated_at<NOW()-INTERVAL '5 minutes'))
        ORDER BY n.created_at LIMIT 10`);
      for (const row of pending) {
        await deliverNotification(pool, { notificationId: row.notification_id, reviewId: row.review_id, recipient: row.recipient });
      }
      if (firstCycle || tags.recovered || reviews.queued || pending.length) log.info("[saved_record_reconciler]", JSON.stringify({
        tagsRecovered: tags.recovered, reviewsQueued: reviews.queued, notificationAttempts: pending.length, osmSent: false,
      }));
      firstCycle = false;
    } catch (error) {
      // 原データは保持。次周期に再試行し、保存APIの応答は巻き込まない。
      log.error("[saved_record_reconciler] retry_pending", error.message);
    } finally {
      running = false;
      if (!stopped) { timer = setTimeout(run, intervalMs); timer.unref?.(); }
    }
  }
  timer = setTimeout(run, initialDelayMs);
  timer.unref?.();
  return { run, stop() { stopped = true; clearTimeout(timer); } };
}
module.exports = { startSavedRecordReconciler };
