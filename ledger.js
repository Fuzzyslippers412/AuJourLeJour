const weeksPerMonth = 4.33;
const daysPerMonthAvg = 30.4;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function clampDueDay(year, month, dueDay) {
  const lastDay = lastDayOfMonth(year, month);
  return Math.min(Math.max(1, dueDay), lastDay);
}

function toDateString(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function isCurrentMonth(year, month, todayDate) {
  return todayDate.getFullYear() === year && todayDate.getMonth() + 1 === month;
}

function computeSummary(instances, options) {
  const {
    year,
    month,
    essentialsOnly,
    todayDate,
  } = options;

  const filtered = essentialsOnly
    ? instances.filter((item) => item.essential_snapshot)
    : [...instances];

  const requiredMonth = filtered
    .filter((item) => item.status_derived !== "skipped")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const paidMonth = filtered
    .filter((item) => item.status_derived !== "skipped")
    .reduce((sum, item) => {
      const due = Number(item.amount || 0);
      const paid = Number(item.amount_paid || 0);
      return sum + Math.min(due, paid);
    }, 0);

  const remainingMonth = filtered
    .filter((item) => item.status_derived !== "skipped")
    .reduce((sum, item) => sum + Number(item.amount_remaining || 0), 0);

  const daysInMonth = getDaysInMonth(year, month);
  const needDailyExact = daysInMonth ? requiredMonth / daysInMonth : 0;
  const needWeeklyExact = needDailyExact * 7;
  const needDailyPlan = requiredMonth / daysPerMonthAvg;
  const needWeeklyPlan = requiredMonth / weeksPerMonth;

  let overduePendingCount = 0;
  if (todayDate && isCurrentMonth(year, month, todayDate)) {
    const todayString = `${todayDate.getFullYear()}-${pad2(
      todayDate.getMonth() + 1
    )}-${pad2(todayDate.getDate())}`;
    overduePendingCount = filtered.filter(
      (item) =>
        item.status_derived !== "skipped" &&
        Number(item.amount_remaining || 0) > 0 &&
        item.due_date < todayString
    ).length;
  }

  const freeForMonth =
    requiredMonth > 0 && remainingMonth === 0 && overduePendingCount === 0;

  return {
    required_month: requiredMonth,
    paid_month: paidMonth,
    remaining_month: remainingMonth,
    need_daily_exact: needDailyExact,
    need_weekly_exact: needWeeklyExact,
    need_daily_plan: needDailyPlan,
    need_weekly_plan: needWeeklyPlan,
    free_for_month: freeForMonth,
    days_in_month: daysInMonth,
  };
}

module.exports = {
  pad2,
  lastDayOfMonth,
  clampDueDay,
  toDateString,
  getDaysInMonth,
  computeSummary,
};
