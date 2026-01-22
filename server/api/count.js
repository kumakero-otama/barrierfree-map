function createCountHandler({
  MAX_MATCH_CALLS_PER_MONTH,
  getCurrentMonth,
  getMonthlyCount,
  monthlyCounts,
  sendJson,
}) {
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
