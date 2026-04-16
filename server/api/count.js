// マッチング API の月次利用状況を外部から参照できるようにするハンドラを生成する。
function createCountHandler({
  MAX_MATCH_CALLS_PER_MONTH,
  getCurrentMonth,
  getMonthlyCount,
  monthlyCounts,
  sendJson,
}) {
  // 月次の利用回数カウンタを可視化するAPI。
  return function handleCount(req, res) {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    const currentMonth = getCurrentMonth();
    const currentCount = getMonthlyCount(currentMonth);
    sendJson(res, 200, {
      count: currentCount,
      max: MAX_MATCH_CALLS_PER_MONTH,
      month: currentMonth,
      allMonths: monthlyCounts,
    });
  };
}

module.exports = createCountHandler;
