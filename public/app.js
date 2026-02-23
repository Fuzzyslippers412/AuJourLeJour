const state = {
  templates: [],
  instances: [],
  payments: [],
  funds: [],
  cashStart: 0,
  selectedTemplates: new Set(),
  nudges: [],
  lastNudgeKey: null,
  llmStatus: { status: "unknown", auth_url: null, error: null },
  llmChecked: false,
  qwenAuth: { connected: false, status: "unknown", session_id: null, verification_uri_complete: null, interval_seconds: null },
  llmHistory: [],
  selectedYear: null,
  selectedMonth: null,
  essentialsOnly: true,
  view: "dashboard",
  templateRows: new Map(),
  filters: {
    search: "",
    status: { pending: true, partial: true, paid: true, skipped: true },
    category: "all",
    sort: "due_date",
  },
};

const weeksPerMonth = 4.33;
const daysPerMonthAvg = 30.4;
let cashSaveTimer = null;

const els = {
  monthPicker: document.getElementById("month-picker"),
  prevMonth: document.getElementById("prev-month"),
  nextMonth: document.getElementById("next-month"),
  essentialsToggle: document.getElementById("essentials-toggle"),
  navDashboard: document.getElementById("nav-dashboard"),
  navTemplates: document.getElementById("nav-templates"),
  backupOpen: document.getElementById("open-backup"),
  backupModal: document.getElementById("backup-modal"),
  backupClose: document.getElementById("close-backup"),
  exportMonth: document.getElementById("export-month"),
  exportBackup: document.getElementById("export-backup"),
  importBackup: document.getElementById("import-backup"),
  dashboardView: document.getElementById("dashboard-view"),
  templatesView: document.getElementById("templates-view"),
  requiredAmount: document.getElementById("required-amount"),
  paidAmount: document.getElementById("paid-amount"),
  remainingAmount: document.getElementById("remaining-amount"),
  needDay: document.getElementById("need-day"),
  needWeek: document.getElementById("need-week"),
  needDayPlan: document.getElementById("need-day-plan"),
  needWeekPlan: document.getElementById("need-week-plan"),
  futureReserved: document.getElementById("future-reserved"),
  cashStart: document.getElementById("cash-start"),
  cashSave: document.getElementById("cash-save"),
  cashSaveStatus: document.getElementById("cash-save-status"),
  cashRemaining: document.getElementById("cash-remaining"),
  statusMain: document.getElementById("status-main"),
  statusSub: document.getElementById("status-sub"),
  heroStatus: document.getElementById("hero-status"),
  overdueList: document.getElementById("overdue-list"),
  dueSoonList: document.getElementById("due-soon-list"),
  nudgesList: document.getElementById("nudges-list"),
  activityList: document.getElementById("activity-list"),
  piggyList: document.getElementById("piggy-list"),
  piggyCard: document.getElementById("piggy-card"),
  openPiggyManage: document.getElementById("open-piggy-manage"),
  llmAgentInput: document.getElementById("llm-agent-input"),
  llmAgentSend: document.getElementById("llm-agent-send"),
  llmAgentOutput: document.getElementById("llm-agent-output"),
  llmAgentHistory: document.getElementById("llm-agent-history"),
  itemsList: document.getElementById("items-list"),
  searchInput: document.getElementById("search-input"),
  categoryFilter: document.getElementById("category-filter"),
  sortFilter: document.getElementById("sort-filter"),
  templateForm: document.getElementById("template-form"),
  templateError: document.getElementById("template-error"),
  templateName: document.getElementById("template-name"),
  templateCategory: document.getElementById("template-category"),
  templateAmount: document.getElementById("template-amount"),
  templateDueDay: document.getElementById("template-due-day"),
  templateEssential: document.getElementById("template-essential"),
  templateAutopay: document.getElementById("template-autopay"),
  templateActive: document.getElementById("template-active"),
  templateNote: document.getElementById("template-note"),
  templateMatchKey: document.getElementById("template-match-key"),
  templateMatchTolerance: document.getElementById("template-match-tolerance"),
  templatesList: document.getElementById("templates-list"),
  applyTemplates: document.getElementById("apply-templates"),
  selectAllTemplates: document.getElementById("select-all-templates"),
  archiveSelected: document.getElementById("archive-selected"),
  deleteSelected: document.getElementById("delete-selected"),
  openIntake: document.getElementById("open-intake"),
  zeroState: document.getElementById("zero-state"),
  zeroTemplatesBtn: document.getElementById("zero-templates-btn"),
  zeroIntakeBtn: document.getElementById("zero-intake-btn"),
  urgencyRow: document.getElementById("urgency-row"),
  itemsCard: document.getElementById("items-card"),
  fundForm: document.getElementById("fund-form"),
  fundError: document.getElementById("fund-error"),
  fundName: document.getElementById("fund-name"),
  fundCategory: document.getElementById("fund-category"),
  fundTarget: document.getElementById("fund-target"),
  fundDueDate: document.getElementById("fund-due-date"),
  fundCadence: document.getElementById("fund-cadence"),
  fundMonths: document.getElementById("fund-months"),
  fundEssential: document.getElementById("fund-essential"),
  fundAuto: document.getElementById("fund-auto"),
  fundActive: document.getElementById("fund-active"),
  fundsList: document.getElementById("funds-list"),
};

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatMoney(value) {
  const amount = Number(value) || 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}

function formatShortDate(dateString) {
  if (!dateString) return "";
  const date = new Date(`${dateString}T00:00:00`);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function isCurrentMonth(year, month) {
  const now = new Date();
  return now.getFullYear() === year && now.getMonth() + 1 === month;
}

function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function getTodayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function diffDays(dateA, dateB) {
  const a = new Date(`${dateA}T00:00:00`);
  const b = new Date(`${dateB}T00:00:00`);
  return Math.round((a - b) / (1000 * 60 * 60 * 24));
}

function parseMonthInput(value) {
  const [year, month] = value.split("-").map(Number);
  return { year, month };
}

function setMonth(year, month) {
  state.selectedYear = year;
  state.selectedMonth = month;
  els.monthPicker.value = `${year}-${pad2(month)}`;
}

async function ensureMonth() {
  await fetch(`/api/ensure-month?year=${state.selectedYear}&month=${state.selectedMonth}`);
}

async function loadTemplates() {
  const res = await fetch("/api/templates");
  state.templates = await res.json();
}

async function loadInstances() {
  const res = await fetch(
    `/api/instances?year=${state.selectedYear}&month=${state.selectedMonth}`
  );
  state.instances = await res.json();
}

async function loadPayments() {
  const res = await fetch(
    `/api/payments?year=${state.selectedYear}&month=${state.selectedMonth}`
  );
  state.payments = await res.json();
}

async function loadMonthSettings() {
  const res = await fetch(
    `/api/month-settings?year=${state.selectedYear}&month=${state.selectedMonth}`
  );
  const data = await res.json();
  state.cashStart = Number(data.cash_start || 0);
  els.cashStart.value = state.cashStart.toFixed(2);
  markCashDirty(false);
  setCashSaveStatus("");
}

async function loadFunds() {
  const res = await fetch(
    `/api/sinking-funds?year=${state.selectedYear}&month=${state.selectedMonth}&include_inactive=1`
  );
  state.funds = await res.json();
}

async function saveMonthSettings(value) {
  await fetch("/api/month-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      year: state.selectedYear,
      month: state.selectedMonth,
      cash_start: value,
    }),
  });
}

function setCashSaveStatus(text, tone = "normal") {
  if (!els.cashSaveStatus) return;
  els.cashSaveStatus.textContent = text || "";
  if (tone === "error") {
    els.cashSaveStatus.style.color = "var(--accent-red)";
  } else if (tone === "success") {
    els.cashSaveStatus.style.color = "var(--accent-green)";
  } else {
    els.cashSaveStatus.style.color = "";
  }
}

function markCashDirty(isDirty) {
  if (els.cashSave) {
    els.cashSave.disabled = !isDirty;
  }
}

function scheduleCashSave() {
  if (cashSaveTimer) clearTimeout(cashSaveTimer);
  setCashSaveStatus("Saving...");
  cashSaveTimer = setTimeout(async () => {
    try {
      await saveMonthSettings(state.cashStart);
      setCashSaveStatus("Saved", "success");
      markCashDirty(false);
    } catch (err) {
      setCashSaveStatus("Save failed", "error");
    }
  }, 600);
}

async function loadQwenAuthStatus() {
  try {
    const res = await fetch("/api/llm/qwen/oauth/status");
    if (!res.ok) return;
    const data = await res.json();
    state.qwenAuth.connected = !!data.connected;
    state.qwenAuth.status = data.connected ? "connected" : "disconnected";
    if (data.connected) {
      state.qwenAuth.session_id = null;
      state.qwenAuth.verification_uri_complete = null;
    } else if (!state.qwenAuth.session_id) {
      await resumeQwenAuth();
    }
  } catch (err) {
    state.qwenAuth.status = "error";
  }
}

async function resumeQwenAuth() {
  try {
    const res = await fetch("/api/llm/qwen/oauth/last");
    if (!res.ok) return;
    const data = await res.json();
    if (data.status !== "pending") return;
    state.qwenAuth = {
      connected: false,
      status: "pending",
      session_id: data.session_id,
      verification_uri_complete: data.verification_uri_complete || data.verification_uri,
      interval_seconds: data.interval_seconds || 5,
    };
    startQwenPolling();
  } catch (err) {
    // ignore
  }
}

let qwenPollTimer = null;

async function startQwenAuth() {
  const res = await fetch("/api/llm/qwen/oauth/start", { method: "POST" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    state.qwenAuth.status = "error";
    state.qwenAuth.error = data.error || "Unable to start agent auth.";
    renderNudges();
    return;
  }
  const data = await res.json();
  state.qwenAuth = {
    connected: false,
    status: "pending",
    session_id: data.session_id,
    verification_uri_complete: data.verification_uri_complete || data.verification_uri,
    interval_seconds: data.interval_seconds || 5,
  };
  renderNudges();
  startQwenPolling();
}

function stopQwenPolling() {
  if (qwenPollTimer) {
    clearTimeout(qwenPollTimer);
    qwenPollTimer = null;
  }
}

async function pollQwenAuth() {
  if (!state.qwenAuth.session_id) return;
  const res = await fetch("/api/llm/qwen/oauth/poll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: state.qwenAuth.session_id }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.status === "pending") {
    state.qwenAuth.status = "pending";
    state.qwenAuth.interval_seconds = data.interval_seconds || state.qwenAuth.interval_seconds || 5;
    renderNudges();
    startQwenPolling();
    return;
  }
  if (data.status === "success") {
    state.qwenAuth.connected = true;
    state.qwenAuth.status = "connected";
    stopQwenPolling();
    renderNudges();
    await refreshAll();
    return;
  }
  if (data.status === "expired") {
    state.qwenAuth.status = "expired";
    stopQwenPolling();
    renderNudges();
    return;
  }
  if (data.status === "error") {
    state.qwenAuth.status = "error";
    state.qwenAuth.error = data.message || "OAuth error";
    stopQwenPolling();
    renderNudges();
  }
}

function startQwenPolling() {
  stopQwenPolling();
  const interval = Number(state.qwenAuth.interval_seconds || 5);
  qwenPollTimer = setTimeout(() => pollQwenAuth(), interval * 1000);
}

async function postAction(payload) {
  const res = await fetch("/api/v1/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action_id: crypto.randomUUID(), ...payload }),
  });
  return res.json();
}

function updateInstanceInState(updated) {
  const idx = state.instances.findIndex((inst) => inst.id === updated.id);
  if (idx >= 0) state.instances[idx] = updated;
}

async function addPayment(instanceId, amount) {
  const res = await fetch(`/api/instances/${instanceId}/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    window.alert(data.error || "Unable to add payment.");
    return;
  }
  const data = await res.json();
  if (data.instance) updateInstanceInState(data.instance);
  await loadPayments();
  renderDashboard();
}

async function undoPayment(paymentId) {
  const res = await fetch(`/api/payments/${paymentId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    window.alert(data.error || "Unable to undo payment.");
    return;
  }
  const data = await res.json();
  if (data.instance) updateInstanceInState(data.instance);
  await loadPayments();
  renderDashboard();
}

async function patchInstance(id, body) {
  const res = await fetch(`/api/instances/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    window.alert(data.error || "Unable to update item.");
    return;
  }
  const updated = await res.json();
  updateInstanceInState(updated);
  renderDashboard();
}

function deriveInstances() {
  const totals = new Map();
  state.payments.forEach((payment) => {
    const key = payment.instance_id;
    const sum = totals.get(key) || 0;
    totals.set(key, sum + Number(payment.amount || 0));
  });

  return state.instances.map((item) => {
    const amountPaid = Number(item.amount_paid ?? totals.get(item.id) ?? 0);
    const amountDue = Number(item.amount || 0);
    const amountRemaining = Math.max(0, amountDue - amountPaid);
    const status =
      item.status === "skipped"
        ? "skipped"
        : amountPaid <= 0
        ? "pending"
        : amountPaid < amountDue
        ? "partial"
        : "paid";
    return {
      ...item,
      amount_paid: amountPaid,
      amount_remaining: amountRemaining,
      status_derived: item.status_derived || status,
    };
  });
}

function getBaseInstances(list) {
  let filtered = list;
  if (state.essentialsOnly) {
    filtered = filtered.filter((item) => item.essential_snapshot);
  }
  return filtered;
}

function computeTotals(list) {
  const required = list
    .filter((item) => item.status_derived !== "skipped")
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const paid = list
    .filter((item) => item.status_derived !== "skipped")
    .reduce((sum, item) => {
      const due = Number(item.amount || 0);
      const paidAmount = Number(item.amount_paid || 0);
      return sum + Math.min(due, paidAmount);
    }, 0);
  const remaining = list
    .filter((item) => item.status_derived !== "skipped")
    .reduce((sum, item) => sum + Number(item.amount_remaining || 0), 0);
  return { required, paid, remaining };
}

function buildLlmContext() {
  const derived = deriveInstances();
  const base = getBaseInstances(derived);
  const totals = computeTotals(base);
  const today = getTodayDateString();
  const overdue = base.filter(
    (item) =>
      item.status_derived !== "skipped" &&
      Number(item.amount_remaining || 0) > 0 &&
      item.due_date < today
  );
  const dueSoon = base.filter((item) => {
    if (item.status_derived === "skipped" || item.amount_remaining <= 0) return false;
    const diff = diffDays(item.due_date, today);
    return diff >= 0 && diff <= 7;
  });
  const freeForMonth =
    totals.required > 0 && totals.remaining === 0 && overdue.length === 0;

  return {
    period: `${state.selectedYear}-${pad2(state.selectedMonth)}`,
    essentials_only: state.essentialsOnly,
    totals: {
      required: totals.required,
      paid: totals.paid,
      remaining: totals.remaining,
    },
    overdue: overdue.map((item) => ({
      name: item.name_snapshot,
      remaining: item.amount_remaining,
      due_date: item.due_date,
    })),
    due_soon: dueSoon.map((item) => ({
      name: item.name_snapshot,
      remaining: item.amount_remaining,
      due_date: item.due_date,
    })),
    free_for_month: freeForMonth,
    templates_count: state.templates.length,
    items_count: base.length,
  };
}

function buildAgentPayload(userText) {
  const derived = deriveInstances();
  const base = getBaseInstances(derived);
  const knownInstances = base.map((item) => ({
    name: item.name_snapshot,
    instance_id: item.id,
    remaining: item.amount_remaining,
    status: item.status_derived,
    due_date: item.due_date,
  }));
  const knownTemplates = state.templates.map((t) => ({
    name: t.name,
    template_id: t.id,
    active: t.active,
  }));
  return {
    user_text: userText,
    period: `${state.selectedYear}-${pad2(state.selectedMonth)}`,
    context: buildLlmContext(),
    known_instances: knownInstances,
    known_templates: knownTemplates,
  };
}

function renderSummary(list) {
  const totals = computeTotals(list);
  const daysInMonth = getDaysInMonth(state.selectedYear, state.selectedMonth);
  const needDailyExact = totals.required / daysInMonth;
  const needWeeklyExact = needDailyExact * 7;
  const needDailyPlan = totals.required / daysPerMonthAvg;
  const needWeeklyPlan = totals.required / weeksPerMonth;

  els.requiredAmount.textContent = formatMoney(totals.required);
  els.paidAmount.textContent = formatMoney(totals.paid);
  els.remainingAmount.textContent = formatMoney(totals.remaining);
  els.needDay.textContent = formatMoney(needDailyExact);
  els.needWeek.textContent = formatMoney(needWeeklyExact);
  els.needDayPlan.textContent = `Planning avg: ${formatMoney(needDailyPlan)}/day`;
  els.needWeekPlan.textContent = `Planning avg: ${formatMoney(needWeeklyPlan)}/week`;
  if (els.futureReserved) {
    const reserved = state.funds
      .filter((fund) => fund.active)
      .reduce(
        (sum, fund) => sum + Math.max(0, Number(fund.balance || 0)),
        0
      );
    els.futureReserved.textContent = formatMoney(reserved);
  }

  return { ...totals, daysInMonth };
}

function renderCash() {
  const totalPaidCash = state.payments.reduce(
    (sum, payment) => sum + Number(payment.amount || 0),
    0
  );
  const remaining = Math.max(0, state.cashStart - totalPaidCash);
  els.cashRemaining.textContent = formatMoney(remaining);
}

function renderStatus(summary, baseList) {
  const currentMonth = isCurrentMonth(
    state.selectedYear,
    state.selectedMonth
  );
  const today = getTodayDateString();
  const overdueCount = baseList.filter(
    (item) =>
      item.status_derived !== "skipped" &&
      item.amount_remaining > 0 &&
      currentMonth &&
      item.due_date < today
  ).length;

  const hasTemplates = state.templates.length > 0;
  const isFree =
    summary.required > 0 && summary.remaining === 0 && overdueCount === 0;

  if (!hasTemplates || summary.required === 0) {
    els.heroStatus.classList.remove("free");
    els.statusMain.textContent = "Add bills to begin";
    els.statusSub.textContent = "Go to Templates to create your essentials.";
    return { isFree: false };
  }

  if (isFree) {
    els.heroStatus.classList.add("free");
    els.statusMain.textContent = "Free for the month — essentials covered.";
    els.statusSub.textContent = "Anything else is saving or optional.";
  } else {
    els.heroStatus.classList.remove("free");
    els.statusMain.textContent = `Still need to cover ${formatMoney(
      summary.remaining
    )}`;
    els.statusSub.textContent = "Keep essentials tight.";
  }

  return { isFree };
}

function renderZeroState() {
  if (state.templates.length === 0) {
    els.zeroState.classList.remove("hidden");
    els.urgencyRow.classList.remove("hidden");
    els.itemsCard.classList.add("hidden");
  } else {
    els.zeroState.classList.add("hidden");
    els.urgencyRow.classList.remove("hidden");
    els.itemsCard.classList.remove("hidden");
  }
}

function renderUrgency(baseList, isFree) {
  els.overdueList.innerHTML = "";
  els.dueSoonList.innerHTML = "";

  if (isFree) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "Nothing urgent right now.";
    els.overdueList.appendChild(empty.cloneNode(true));
    els.dueSoonList.appendChild(empty);
    return;
  }

  if (!isCurrentMonth(state.selectedYear, state.selectedMonth)) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "Nothing urgent right now.";
    els.overdueList.appendChild(empty);
    els.dueSoonList.appendChild(empty.cloneNode(true));
    return;
  }

  const today = getTodayDateString();
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  const nextWeekString = `${nextWeek.getFullYear()}-${pad2(
    nextWeek.getMonth() + 1
  )}-${pad2(nextWeek.getDate())}`;

  const overdue = baseList.filter(
    (item) =>
      item.status_derived !== "skipped" &&
      item.amount_remaining > 0 &&
      item.due_date < today
  );
  const dueSoon = baseList.filter(
    (item) =>
      item.status_derived !== "skipped" &&
      item.amount_remaining > 0 &&
      item.due_date >= today &&
      item.due_date <= nextWeekString
  );

  const renderItem = (item, overdueFlag) => {
    const row = document.createElement("div");
    row.className = `list-item ${overdueFlag ? "overdue" : ""}`.trim();

    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "title";
    name.textContent = item.name_snapshot;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `Due ${formatShortDate(item.due_date)} · Remaining ${formatMoney(
      item.amount_remaining
    )}`;
    left.appendChild(name);
    left.appendChild(meta);

    if (item.autopay_snapshot) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Autopay";
      meta.appendChild(document.createTextNode(" "));
      meta.appendChild(badge);
    }

    const actions = document.createElement("div");
    actions.className = "list-actions";

    const payFull = document.createElement("button");
    payFull.className = "btn-small btn-primary";
    payFull.textContent = "Pay full";
    payFull.addEventListener("click", () => {
      if (item.amount_remaining > 0) {
        addPayment(item.id, item.amount_remaining);
      }
    });

    const addBtn = document.createElement("button");
    addBtn.className = "btn-small";
    addBtn.textContent = "Add payment";
    addBtn.addEventListener("click", () => {
      const raw = window.prompt("Payment amount:");
      if (!raw) return;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) return;
      addPayment(item.id, value);
    });

    actions.appendChild(payFull);
    actions.appendChild(addBtn);

    row.appendChild(left);
    row.appendChild(actions);
    return row;
  };

  if (overdue.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "Nothing urgent right now.";
    els.overdueList.appendChild(empty);
  } else {
    overdue.forEach((item) => els.overdueList.appendChild(renderItem(item, true)));
  }

  if (dueSoon.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "Nothing urgent right now.";
    els.dueSoonList.appendChild(empty);
  } else {
    dueSoon.forEach((item) => els.dueSoonList.appendChild(renderItem(item, false)));
  }
}

function formatMonthYear(dateString) {
  if (!dateString) return "";
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.valueOf())) return dateString;
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function progressColor(ratio) {
  if (ratio >= 1) return "linear-gradient(90deg, #2e7d32, #66bb6a)";
  if (ratio >= 0.7) return "linear-gradient(90deg, #1e88e5, #42a5f5)";
  if (ratio >= 0.4) return "linear-gradient(90deg, #f9a825, #ffb300)";
  return "linear-gradient(90deg, #d32f2f, #ef5350)";
}

function statusLabel(status) {
  if (status === "ready") return "Ready";
  if (status === "behind") return "Behind";
  if (status === "due") return "Due";
  return "On track";
}

async function handlePiggyEvent(fundId, type, amount) {
  await postAction({
    type: "ADD_SINKING_EVENT",
    fund_id: fundId,
    event_type: type,
    amount,
  });
  await refreshAll();
}

async function handleMarkFundPaid(fundId) {
  await postAction({
    type: "MARK_FUND_PAID",
    fund_id: fundId,
  });
  await refreshAll();
}

function renderPiggy() {
  if (!els.piggyList) return;
  els.piggyList.innerHTML = "";
  const activeFunds = (state.funds || []).filter((fund) => fund.active);
  if (activeFunds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "No piggy banks yet.";
    els.piggyList.appendChild(empty);
    return;
  }

  activeFunds.forEach((fund) => {
    const row = document.createElement("div");
    row.className = "piggy-row";

    const name = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = fund.name;
    const meta = document.createElement("div");
    meta.className = "piggy-meta";
    meta.textContent = `Due ${formatMonthYear(fund.due_date)}`;
    const status = document.createElement("div");
    status.className = `status-pill ${fund.status || "on_track"}`;
    status.textContent = statusLabel(fund.status);
    name.appendChild(title);
    name.appendChild(meta);
    name.appendChild(status);

    const target = document.createElement("div");
    target.innerHTML = `<div class="piggy-meta">Target</div><div>${formatMoney(
      fund.target_amount
    )}</div>`;

    const saved = document.createElement("div");
    saved.innerHTML = `<div class="piggy-meta">Saved</div><div>${formatMoney(
      fund.balance || 0
    )}</div>`;

    const monthly = document.createElement("div");
    monthly.innerHTML = `<div class="piggy-meta">Monthly</div><div>${formatMoney(
      fund.monthly_contrib || 0
    )}</div>`;

    const progress = document.createElement("div");
    const bar = document.createElement("div");
    bar.className = "piggy-progress";
    const fill = document.createElement("span");
    const ratio = Number(fund.progress_ratio || 0);
    fill.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
    fill.style.background = progressColor(ratio);
    bar.appendChild(fill);
    const progressMeta = document.createElement("div");
    progressMeta.className = "piggy-meta";
    progressMeta.textContent = `${Math.round(Math.min(100, ratio * 100))}%`;
    progress.appendChild(bar);
    progress.appendChild(progressMeta);

    const actions = document.createElement("div");
    actions.className = "piggy-actions";
    const amountInput = document.createElement("input");
    amountInput.type = "number";
    amountInput.min = "0";
    amountInput.step = "0.01";
    amountInput.placeholder = "+ Amount";

    const addBtn = document.createElement("button");
    addBtn.className = "btn-small";
    addBtn.textContent = "Add";
    addBtn.addEventListener("click", () => {
      const amount = Number(amountInput.value);
      if (!Number.isFinite(amount) || amount <= 0) return;
      handlePiggyEvent(fund.id, "CONTRIBUTION", amount);
    });

    const withdrawBtn = document.createElement("button");
    withdrawBtn.className = "btn-small";
    withdrawBtn.textContent = "Withdraw";
    withdrawBtn.addEventListener("click", () => {
      const amount = Number(amountInput.value);
      if (!Number.isFinite(amount) || amount <= 0) return;
      handlePiggyEvent(fund.id, "WITHDRAWAL", amount);
    });

    const paidBtn = document.createElement("button");
    paidBtn.className = "btn-small";
    paidBtn.textContent = "Mark paid";
    paidBtn.addEventListener("click", () => handleMarkFundPaid(fund.id));

    const editBtn = document.createElement("button");
    editBtn.className = "btn-small";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      state.view = "templates";
      renderView();
      document.getElementById("funds-section")?.scrollIntoView({ behavior: "smooth" });
    });

    actions.appendChild(amountInput);
    actions.appendChild(addBtn);
    actions.appendChild(withdrawBtn);
    actions.appendChild(paidBtn);
    actions.appendChild(editBtn);

    row.appendChild(name);
    row.appendChild(target);
    row.appendChild(saved);
    row.appendChild(monthly);
    row.appendChild(progress);
    row.appendChild(actions);

    els.piggyList.appendChild(row);
  });
}

function renderActivity() {
  els.activityList.innerHTML = "";
  if (state.payments.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "No recent payments.";
    els.activityList.appendChild(empty);
    return;
  }

  const instanceMap = new Map(
    state.instances.map((inst) => [inst.id, inst.name_snapshot])
  );

  state.payments.slice(0, 10).forEach((payment) => {
    const row = document.createElement("div");
    row.className = "list-item";

    const left = document.createElement("div");
    const name = instanceMap.get(payment.instance_id) || "Payment";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = `Paid ${formatMoney(payment.amount)} → ${name}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = formatShortDate(payment.paid_date);
    left.appendChild(title);
    left.appendChild(meta);

    const actions = document.createElement("div");
    const undo = document.createElement("button");
    undo.className = "btn-small";
    undo.textContent = "Undo";
    undo.addEventListener("click", () => undoPayment(payment.id));
    actions.appendChild(undo);

    row.appendChild(left);
    row.appendChild(actions);
    els.activityList.appendChild(row);
  });
}

function buildNudgeEvents(baseList, summary, isFree) {
  const events = [];
  const today = getTodayDateString();

  if (isFree) {
    events.push({
      type: "FREE_FOR_MONTH",
      severity: "success",
      facts: { remaining: summary.remaining },
    });
    return events;
  }

  const overdueItems = baseList.filter(
    (item) =>
      item.status_derived !== "skipped" &&
      item.amount_remaining > 0 &&
      item.due_date < today
  );
  if (overdueItems.length > 0) {
    events.push({
      type: "OVERDUE",
      severity: "urgent",
      facts: {
        count: overdueItems.length,
        total_remaining: overdueItems.reduce(
          (sum, item) => sum + Number(item.amount_remaining || 0),
          0
        ),
        items: overdueItems.slice(0, 3).map((item) => item.name_snapshot),
      },
    });
  }

  const dueSoonItems = baseList.filter((item) => {
    if (item.status_derived === "skipped" || item.amount_remaining <= 0) return false;
    const diff = diffDays(item.due_date, today);
    return diff >= 0 && diff <= 7;
  });
  if (dueSoonItems.length > 0) {
    const soonest = dueSoonItems.sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
    events.push({
      type: "DUE_SOON",
      severity: "warn",
      facts: {
        count: dueSoonItems.length,
        days_left: diffDays(soonest.due_date, today),
        item: soonest.name_snapshot,
        remaining: soonest.amount_remaining,
      },
    });
  }

  return events.slice(0, 3);
}

function fallbackNudges(events) {
  return events.map((event, index) => {
    if (event.type === "OVERDUE") {
      return {
        id: `overdue_${index}`,
        severity: "urgent",
        title: `${event.facts.count} bill(s) overdue`,
        body: "Clear overdue items to stay on track.",
        cta: { label: "Open overdue", action_type: "OPEN_OVERDUE", payload: null },
      };
    }
    if (event.type === "DUE_SOON") {
      return {
        id: `due_${index}`,
        severity: "warn",
        title: `${event.facts.item} due in ${event.facts.days_left} days`,
        body: "Pay full or add a partial payment.",
        cta: { label: "Open due soon", action_type: "OPEN_DUE_SOON", payload: null },
      };
    }
    return {
      id: `free_${index}`,
      severity: "success",
      title: "Free for the month",
      body: "Essentials are covered. Everything else is optional.",
      cta: { label: "View summary", action_type: "OPEN_SUMMARY", payload: null },
    };
  });
}

async function fetchNudges(events) {
  if (!els.nudgesList) return;
  if (state.qwenAuth && state.qwenAuth.connected === false) {
    state.nudges = [];
    renderNudges();
    return;
  }
  const shouldProbe = events.length === 0 && !state.llmChecked;
  if (events.length === 0 && !shouldProbe) {
    state.nudges = [];
    renderNudges();
    return;
  }
  if (shouldProbe) {
    state.llmChecked = true;
  }
  try {
    const res = await fetch("/internal/advisor/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "nudges",
        payload: {
          period: `${state.selectedYear}-${pad2(state.selectedMonth)}`,
          essentials_only: state.essentialsOnly,
          trigger_events: events,
        },
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.auth_url) {
        state.llmStatus = { status: "auth_required", auth_url: data.auth_url, error: data.error || "" };
      } else {
        state.llmStatus = { status: "unavailable", auth_url: null, error: data.error || "Agent unavailable" };
      }
      state.nudges = fallbackNudges(events);
      renderNudges();
      return;
    }
    const data = await res.json();
    state.llmStatus = { status: "ok", auth_url: null, error: null };
    state.nudges = data?.data?.messages || fallbackNudges(events);
    renderNudges();
  } catch (err) {
    state.llmStatus = { status: "unavailable", auth_url: null, error: err.message || "Agent unavailable" };
    state.nudges = fallbackNudges(events);
    renderNudges();
  }
}

function pushLlmMessage(role, text, meta = "") {
  if (!text) return;
  state.llmHistory.push({ role, text, meta });
  if (state.llmHistory.length > 10) {
    state.llmHistory = state.llmHistory.slice(-10);
  }
  renderLlmHistory();
}

function renderLlmHistory() {
  if (!els.llmAgentHistory) return;
  els.llmAgentHistory.innerHTML = "";
  if (!state.llmHistory || state.llmHistory.length === 0) return;
  state.llmHistory.forEach((entry) => {
    const row = document.createElement("div");
    row.className = `assistant-message ${entry.role}`;
    const text = document.createElement("div");
    text.textContent = entry.text;
    row.appendChild(text);
    if (entry.meta) {
      const meta = document.createElement("div");
      meta.className = "assistant-meta";
      meta.textContent = entry.meta;
      row.appendChild(meta);
    }
    els.llmAgentHistory.appendChild(row);
  });
  els.llmAgentHistory.scrollTop = els.llmAgentHistory.scrollHeight;
}

async function applyProposal(proposal) {
  if (!proposal) return { ok: false, message: "No action found." };
  const derived = deriveInstances();
  const base = getBaseInstances(derived);
  const targetName = proposal.target?.name;
  let instance = null;
  let template = null;

  if (proposal.target?.type === "instance") {
    instance = findInstanceByName(targetName, base);
  } else if (proposal.target?.type === "template") {
    template = findTemplateByName(targetName);
  }

  if (!instance && proposal.intent && proposal.intent.startsWith("SHOW_")) {
    if (proposal.intent === "SHOW_DUE_SOON") {
      document.getElementById("due-soon-list")?.scrollIntoView({ behavior: "smooth" });
    } else if (proposal.intent === "SHOW_OVERDUE") {
      document.getElementById("overdue-list")?.scrollIntoView({ behavior: "smooth" });
    } else if (proposal.intent === "SHOW_TEMPLATES") {
      state.view = "templates";
      renderView();
    } else {
      document.querySelector(".hero")?.scrollIntoView({ behavior: "smooth" });
    }
    return { ok: true, message: "Opened the requested section." };
  }

  const intent = proposal.intent;
  if (intent === "SET_CASH_START") {
    const cash = Number(proposal.payload?.cash_start);
    if (!Number.isFinite(cash) || cash < 0) {
      return { ok: false, message: "Invalid cash amount." };
    }
    state.cashStart = cash;
    if (els.cashStart) els.cashStart.value = cash.toFixed(2);
    renderCash();
    await saveMonthSettings(cash);
    return { ok: true, message: "Cash start updated." };
  }

  if (intent === "CREATE_TEMPLATE") {
    const payload = proposal.payload || {};
    if (!payload.name || payload.amount_default == null) {
      return { ok: false, message: "Missing template details." };
    }
    await postAction({
      type: "CREATE_TEMPLATE",
      name: payload.name,
      category: payload.category || null,
      amount_default: Number(payload.amount_default || 0),
      due_day: Number(payload.due_day || 1),
      essential: payload.essential !== false,
      autopay: !!payload.autopay,
      active: payload.active !== false,
      default_note: payload.default_note || null,
      match_payee_key: payload.match_payee_key || null,
      match_amount_tolerance: Number(payload.match_amount_tolerance || 5),
    });
    await refreshAll();
    return { ok: true, message: "Template created." };
  }

  if (intent === "UPDATE_TEMPLATE") {
    if (!template) return { ok: false, message: "Template not found." };
    const payload = {
      name: template.name,
      category: template.category || null,
      amount_default: template.amount_default,
      due_day: template.due_day,
      essential: template.essential,
      autopay: template.autopay,
      active: template.active,
      default_note: template.default_note || null,
      match_payee_key: template.match_payee_key || null,
      match_amount_tolerance: template.match_amount_tolerance ?? 5,
      ...(proposal.payload || {}),
    };
    await postAction({
      type: "UPDATE_TEMPLATE",
      template_id: template.id,
      ...payload,
    });
    await refreshAll();
    return { ok: true, message: "Template updated." };
  }

  if (intent === "ARCHIVE_TEMPLATE") {
    if (!template) return { ok: false, message: "Template not found." };
    await postAction({ type: "ARCHIVE_TEMPLATE", template_id: template.id });
    await refreshAll();
    return { ok: true, message: "Template archived." };
  }

  if (!instance) {
    return { ok: false, message: "Could not resolve the target bill." };
  }
  if (intent === "MARK_PAID") {
    await postAction({ type: "MARK_PAID", instance_id: instance.id, paid_date: todayDate() });
  } else if (intent === "MARK_PENDING") {
    await postAction({ type: "MARK_PENDING", instance_id: instance.id });
  } else if (intent === "SKIP_INSTANCE") {
    await postAction({ type: "SKIP_INSTANCE", instance_id: instance.id });
  } else if (intent === "ADD_PAYMENT") {
    const mode = proposal.payload?.amount_mode || "FIXED";
    let amount = 0;
    if (mode === "FULL_REMAINING") amount = Number(instance.amount_remaining || 0);
    else if (mode === "FRACTION") {
      amount = Number(instance.amount_remaining || 0) * Number(proposal.payload?.fraction || 0);
    } else {
      amount = Number(proposal.payload?.amount || 0);
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, message: "Invalid payment amount." };
    }
    await postAction({ type: "ADD_PAYMENT", instance_id: instance.id, amount });
  } else if (intent === "UPDATE_INSTANCE_FIELDS") {
    await postAction({
      type: "UPDATE_INSTANCE_FIELDS",
      instance_id: instance.id,
      amount: proposal.payload?.amount,
      due_date: proposal.payload?.due_date,
      note: proposal.payload?.note,
    });
  } else {
    return { ok: false, message: "Unsupported command." };
  }

  await refreshAll();
  return { ok: true, message: "Done." };
}

async function applyIntakeTemplates(templates) {
  if (!Array.isArray(templates) || templates.length === 0) {
    return { created: 0, skipped: 0, message: "No templates detected." };
  }
  const existingNames = new Set(state.templates.map((t) => t.name.toLowerCase()));
  let created = 0;
  let skipped = 0;
  for (const template of templates) {
    const name = String(template.name || "").trim();
    const amount = Number(template.amount_default);
    if (!name || !Number.isFinite(amount) || amount < 0) {
      skipped += 1;
      continue;
    }
    if (existingNames.has(name.toLowerCase())) {
      skipped += 1;
      continue;
    }
    const dueDay = Number(template.due_day_guess);
    const payload = {
      type: "CREATE_TEMPLATE",
      name,
      category: template.category || null,
      amount_default: amount,
      due_day: Number.isFinite(dueDay) ? Math.min(31, Math.max(1, Math.round(dueDay))) : 1,
      autopay: !!template.autopay_guess,
      essential: template.essential_guess !== false,
      active: true,
      default_note: template.notes || null,
      match_payee_key: template.match_payee_key_guess || null,
      match_amount_tolerance:
        Number.isFinite(Number(template.match_amount_tolerance_guess)) ?
          Number(template.match_amount_tolerance_guess) :
          5,
      year: state.selectedYear,
      month: state.selectedMonth,
    };
    await postAction(payload);
    existingNames.add(name.toLowerCase());
    created += 1;
  }
  await refreshAll();
  return {
    created,
    skipped,
    message: created > 0 ? `Saved ${created} templates.` : "No templates were saved.",
  };
}

async function sendLlmAgent() {
  if (!els.llmAgentInput || !els.llmAgentOutput) return;
  if (state.qwenAuth && !state.qwenAuth.connected) {
    els.llmAgentOutput.textContent = "Connect agent first.";
    return;
  }
  const text = els.llmAgentInput.value.trim();
  if (!text) return;
  els.llmAgentOutput.textContent = "Thinking...";
  pushLlmMessage("user", text);
  els.llmAgentInput.value = "";

  try {
    const res = await fetch("/internal/advisor/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "agent",
        payload: buildAgentPayload(text),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data?.ok) {
      if (data?.auth_url) {
        state.llmStatus = { status: "auth_required", auth_url: data.auth_url, error: data.error || "" };
      } else {
        state.llmStatus = { status: "unavailable", auth_url: null, error: data?.error || "Agent unavailable" };
      }
      renderNudges();
      els.llmAgentOutput.textContent = data?.error || "Agent unavailable.";
      pushLlmMessage("assistant", "Agent unavailable.", data?.error || "");
      return;
    }

    const result = data?.data || {};
    const kind = result.kind || "ask";
    if (kind === "ask") {
      const answer = result.answer || "No response.";
      els.llmAgentOutput.textContent = "";
      pushLlmMessage("assistant", answer);
      return;
    }

    if (kind === "command") {
      const proposal = result.proposal || null;
      if (proposal?.clarifying_question) {
        els.llmAgentOutput.textContent = "";
        pushLlmMessage("assistant", proposal.clarifying_question);
        return;
      }
      const summary = summarizeProposal(proposal);
      const outcome = await applyProposal(proposal);
      els.llmAgentOutput.textContent = "";
      pushLlmMessage("assistant", outcome.message, summary);
      return;
    }

    if (kind === "intake") {
      const questions = result.questions || [];
      const warnings = result.warnings || [];
      if (questions.length > 0) {
        const questionText = questions.map((q) => q.question).join(" ");
        els.llmAgentOutput.textContent = "";
        pushLlmMessage("assistant", questionText || "Need more details.");
        return;
      }
      const templates = result.templates || [];
      const outcome = await applyIntakeTemplates(templates);
      const warningText = warnings.length > 0 ? warnings.join(" ") : "";
      els.llmAgentOutput.textContent = "";
      pushLlmMessage("assistant", outcome.message, warningText);
      return;
    }

    els.llmAgentOutput.textContent = "";
    pushLlmMessage("assistant", "No response.");
  } catch (err) {
    els.llmAgentOutput.textContent = "Agent unavailable.";
    pushLlmMessage("assistant", "Agent unavailable.");
  }
}

function findInstanceByName(name, baseList) {
  if (!name) return null;
  const target = name.toLowerCase();
  const exact = baseList.find((item) => item.name_snapshot.toLowerCase() === target);
  if (exact) return exact;
  const partial = baseList.find((item) => item.name_snapshot.toLowerCase().includes(target));
  return partial || null;
}

function findTemplateByName(name) {
  if (!name) return null;
  const target = name.toLowerCase();
  const exact = state.templates.find((t) => t.name.toLowerCase() === target);
  if (exact) return exact;
  const partial = state.templates.find((t) => t.name.toLowerCase().includes(target));
  return partial || null;
}

function summarizeProposal(proposal) {
  if (!proposal) return "No proposal.";
  const intent = proposal.intent || "UNKNOWN";
  const target = proposal.target?.name || "Unknown";
  if (intent === "MARK_PAID") return `Mark paid: ${target}`;
  if (intent === "SKIP_INSTANCE") return `Skip: ${target}`;
  if (intent === "MARK_PENDING") return `Mark pending: ${target}`;
  if (intent === "ADD_PAYMENT") {
    const mode = proposal.payload?.amount_mode || "FIXED";
    if (mode === "FULL_REMAINING") return `Pay full remaining: ${target}`;
    if (mode === "FRACTION") return `Pay ${proposal.payload?.fraction || 0} of ${target}`;
    return `Add payment to ${target}`;
  }
  if (intent === "UPDATE_INSTANCE_FIELDS") return `Update ${target}`;
  return `Intent: ${intent}`;
}


function renderNudges() {
  if (!els.nudgesList) return;
  els.nudgesList.innerHTML = "";
  let hasStatusRow = false;

  if (state.qwenAuth && !state.qwenAuth.connected) {
    const row = document.createElement("div");
    row.className = "list-item";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Connect agent";
    const body = document.createElement("div");
    body.className = "meta";
    if (state.qwenAuth.status === "pending" && state.qwenAuth.verification_uri_complete) {
      body.textContent = "Authorize in browser, then return here.";
    } else if (state.qwenAuth.status === "error") {
      body.textContent = state.qwenAuth.error || "Unable to start agent auth.";
    } else if (state.qwenAuth.status === "expired") {
      body.textContent = "Login expired. Start again.";
    } else {
      body.textContent = "Use agent login to enable nudges.";
    }
    left.appendChild(title);
    left.appendChild(body);

    if (state.qwenAuth.verification_uri_complete) {
      const link = document.createElement("a");
      link.className = "btn-small";
      link.href = state.qwenAuth.verification_uri_complete;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open login";
      row.appendChild(left);
      row.appendChild(link);
    } else {
      const action = document.createElement("button");
      action.className = "btn-small";
      action.textContent = "Start login";
      action.addEventListener("click", () => startQwenAuth());
      row.appendChild(left);
      row.appendChild(action);
    }
    els.nudgesList.appendChild(row);
    hasStatusRow = true;
  } else if (state.qwenAuth && state.qwenAuth.connected) {
    const row = document.createElement("div");
    row.className = "list-item";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Agent connected";
    const body = document.createElement("div");
    body.className = "meta";
    body.textContent = "Mamdou is ready.";
    left.appendChild(title);
    left.appendChild(body);
    row.appendChild(left);
    els.nudgesList.appendChild(row);
    hasStatusRow = true;
  }

  if (state.llmStatus?.status === "unavailable") {
    const row = document.createElement("div");
    row.className = "list-item";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Agent error";
    const body = document.createElement("div");
    body.className = "meta";
    body.textContent = state.llmStatus.error || "Agent unavailable.";
    left.appendChild(title);
    left.appendChild(body);
    row.appendChild(left);
    els.nudgesList.appendChild(row);
    hasStatusRow = true;
  }

  if (state.llmStatus?.status === "auth_required" && state.llmStatus.auth_url) {
    const row = document.createElement("div");
    row.className = "list-item";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Agent login required";
    const body = document.createElement("div");
    body.className = "meta";
    body.textContent = "Click to complete the device authorization.";
    left.appendChild(title);
    left.appendChild(body);
    const link = document.createElement("a");
    link.className = "btn-small";
    link.href = state.llmStatus.auth_url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Complete login";
    row.appendChild(left);
    row.appendChild(link);
    els.nudgesList.appendChild(row);
    hasStatusRow = true;
  } else if (state.llmStatus?.status === "unavailable") {
    const row = document.createElement("div");
    row.className = "list-item";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Agent unavailable";
    const body = document.createElement("div");
    body.className = "meta";
    body.textContent = state.llmStatus.error || "Check your gateway connection.";
    left.appendChild(title);
    left.appendChild(body);
    row.appendChild(left);
    els.nudgesList.appendChild(row);
    hasStatusRow = true;
  }

  if (!state.nudges || state.nudges.length === 0) {
    if (!hasStatusRow) {
      const empty = document.createElement("div");
      empty.className = "meta";
      empty.textContent = "No nudges right now.";
      els.nudgesList.appendChild(empty);
    }
    return;
  }

  state.nudges.forEach((message) => {
    const row = document.createElement("div");
    row.className = "list-item";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = message.title || "Nudge";
    const body = document.createElement("div");
    body.className = "meta";
    body.textContent = message.body || "";
    left.appendChild(title);
    left.appendChild(body);

    row.appendChild(left);

    if (message.cta?.label) {
      const action = document.createElement("button");
      action.className = "btn-small";
      action.textContent = message.cta.label;
      action.addEventListener("click", () => handleNudgeAction(message.cta));
      row.appendChild(action);
    }

    els.nudgesList.appendChild(row);
  });
}

function handleNudgeAction(cta) {
  if (!cta) return;
  if (cta.action_type === "OPEN_OVERDUE") {
    document.getElementById("overdue-list")?.scrollIntoView({ behavior: "smooth" });
  } else if (cta.action_type === "OPEN_DUE_SOON") {
    document.getElementById("due-soon-list")?.scrollIntoView({ behavior: "smooth" });
  } else if (cta.action_type === "OPEN_TEMPLATES") {
    state.view = "templates";
    renderView();
  } else {
    document.querySelector(".hero")?.scrollIntoView({ behavior: "smooth" });
  }
}


function renderCategoryFilter(list) {
  const categories = new Set();
  list.forEach((item) => {
    if (item.category_snapshot) categories.add(item.category_snapshot);
  });

  const current = state.filters.category;
  els.categoryFilter.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All";
  els.categoryFilter.appendChild(allOption);

  Array.from(categories)
    .sort((a, b) => a.localeCompare(b))
    .forEach((cat) => {
      const option = document.createElement("option");
      option.value = cat;
      option.textContent = cat;
      if (cat === current) option.selected = true;
      els.categoryFilter.appendChild(option);
    });

  if (!categories.has(current)) {
    state.filters.category = "all";
  }
}

function renderItems(baseList) {
  const filters = state.filters;
  let list = baseList.filter((item) => filters.status[item.status_derived]);

  if (filters.category !== "all") {
    list = list.filter((item) => (item.category_snapshot || "") === filters.category);
  }

  if (filters.search) {
    const term = filters.search.toLowerCase();
    list = list.filter(
      (item) =>
        item.name_snapshot.toLowerCase().includes(term) ||
        (item.category_snapshot || "").toLowerCase().includes(term)
    );
  }

  list.sort((a, b) => {
    if (filters.sort === "amount") {
      return Number(a.amount) - Number(b.amount);
    }
    if (filters.sort === "name") {
      return a.name_snapshot.localeCompare(b.name_snapshot);
    }
    const dueCompare = a.due_date.localeCompare(b.due_date);
    if (dueCompare !== 0) return dueCompare;
    return a.name_snapshot.localeCompare(b.name_snapshot);
  });

  els.itemsList.innerHTML = "";
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent =
      state.instances.length === 0
        ? "Add your first bill to get started."
        : "No matches.";
    els.itemsList.appendChild(empty);
    return;
  }

  const today = getTodayDateString();
  const currentMonth = isCurrentMonth(state.selectedYear, state.selectedMonth);

  list.forEach((item) => {
    const isOverdue =
      currentMonth && item.amount_remaining > 0 && item.due_date < today;

    const row = document.createElement("div");
    row.className = `item-row ${isOverdue ? "overdue" : ""}`;

    const statusCell = document.createElement("div");
    const statusPill = document.createElement("div");
    statusPill.className = `status-pill status-${item.status_derived}`;
    statusPill.textContent = item.status_derived.charAt(0).toUpperCase() + item.status_derived.slice(1);
    statusCell.appendChild(statusPill);

    const main = document.createElement("div");
    main.className = "item-main";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = item.name_snapshot;
    const meta = document.createElement("div");
    meta.className = "meta";
    const metaParts = [];
    if (item.category_snapshot) {
      const span = document.createElement("span");
      span.textContent = item.category_snapshot;
      metaParts.push(span);
    }
    if (item.autopay_snapshot) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Autopay";
      metaParts.push(badge);
    }
    if (item.status_derived === "partial") {
      const span = document.createElement("span");
      span.textContent = `${formatMoney(item.amount_paid)} paid / ${formatMoney(
        item.amount
      )} due`;
      metaParts.push(span);
    }
    metaParts.forEach((part, index) => {
      if (index > 0) {
        const dot = document.createElement("span");
        dot.textContent = " · ";
        meta.appendChild(dot);
      }
      meta.appendChild(part);
    });
    if (item.note) {
      const noteDot = document.createElement("span");
      noteDot.className = "note-indicator";
      noteDot.title = item.note;
      meta.appendChild(noteDot);
    }
    main.appendChild(name);
    main.appendChild(meta);

    const due = document.createElement("div");
    due.textContent = formatShortDate(item.due_date);

    const amountDue = document.createElement("div");
    amountDue.textContent = formatMoney(item.amount);

    const amountPaid = document.createElement("div");
    amountPaid.textContent = formatMoney(item.amount_paid);

    const remaining = document.createElement("div");
    remaining.textContent = formatMoney(item.amount_remaining);

    const paymentWrap = document.createElement("div");
    const paymentGroup = document.createElement("div");
    paymentGroup.className = "payment-inline";
    const plus = document.createElement("span");
    plus.textContent = "+";
    const paymentInput = document.createElement("input");
    paymentInput.type = "number";
    paymentInput.min = "0";
    paymentInput.step = "0.01";
    paymentInput.className = "inline-input";
    paymentInput.placeholder = "0.00";
    const applyBtn = document.createElement("button");
    applyBtn.className = "btn-small";
    applyBtn.textContent = "Apply";
    applyBtn.addEventListener("click", () => {
      const value = Number(paymentInput.value);
      if (!Number.isFinite(value) || value <= 0) return;
      addPayment(item.id, value);
      paymentInput.value = "";
    });
    paymentGroup.appendChild(plus);
    paymentGroup.appendChild(paymentInput);
    paymentGroup.appendChild(applyBtn);
    paymentWrap.appendChild(paymentGroup);

    const payFullWrap = document.createElement("div");
    const payFull = document.createElement("button");
    payFull.className = "btn-small btn-primary";
    payFull.textContent = "Pay full";
    payFull.addEventListener("click", () => {
      if (item.amount_remaining > 0) {
        addPayment(item.id, item.amount_remaining);
      }
    });
    payFullWrap.appendChild(payFull);

    const actionsWrap = document.createElement("div");
    const kebab = document.createElement("button");
    kebab.className = "kebab";
    kebab.textContent = "⋯";
    kebab.addEventListener("click", () => {
      const choice = window.prompt("Actions: note, skip, unskip");
      if (!choice) return;
      const action = choice.toLowerCase().trim();
      if (action === "note") {
        const note = window.prompt("Note:", item.note || "");
        if (note !== null) patchInstance(item.id, { note });
      }
      if (action === "skip") {
        patchInstance(item.id, { status: "skipped" });
      }
      if (action === "unskip") {
        patchInstance(item.id, { status: "pending" });
      }
    });
    actionsWrap.appendChild(kebab);

    row.appendChild(statusCell);
    row.appendChild(main);
    row.appendChild(due);
    row.appendChild(amountDue);
    row.appendChild(amountPaid);
    row.appendChild(remaining);
    row.appendChild(paymentWrap);
    row.appendChild(payFullWrap);
    row.appendChild(actionsWrap);

    els.itemsList.appendChild(row);
  });
}

function renderTemplates() {
  els.templatesList.innerHTML = "";
  state.templateRows = new Map();
  if (state.templates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "Add your first bill to get started.";
    els.templatesList.appendChild(empty);
    if (els.selectAllTemplates) els.selectAllTemplates.checked = false;
    if (els.archiveSelected) els.archiveSelected.disabled = true;
    if (els.deleteSelected) els.deleteSelected.disabled = true;
    renderFundsList();
    return;
  }

  const templateIds = new Set(state.templates.map((t) => t.id));
  state.selectedTemplates.forEach((id) => {
    if (!templateIds.has(id)) state.selectedTemplates.delete(id);
  });
  if (els.selectAllTemplates) {
    els.selectAllTemplates.checked =
      state.selectedTemplates.size > 0 &&
      state.selectedTemplates.size === state.templates.length;
  }
  if (els.archiveSelected) els.archiveSelected.disabled = state.selectedTemplates.size === 0;
  if (els.deleteSelected) els.deleteSelected.disabled = state.selectedTemplates.size === 0;

  state.templates.forEach((template) => {
    const row = document.createElement("div");
    row.className = "template-row";

    const selectWrap = document.createElement("div");
    const selectInput = document.createElement("input");
    selectInput.type = "checkbox";
    selectInput.checked = state.selectedTemplates.has(template.id);
    selectInput.addEventListener("change", () => {
      if (selectInput.checked) {
        state.selectedTemplates.add(template.id);
      } else {
        state.selectedTemplates.delete(template.id);
      }
      if (els.selectAllTemplates) {
        els.selectAllTemplates.checked =
          state.selectedTemplates.size > 0 &&
          state.selectedTemplates.size === state.templates.length;
      }
      if (els.archiveSelected) {
        els.archiveSelected.disabled = state.selectedTemplates.size === 0;
      }
      if (els.deleteSelected) {
        els.deleteSelected.disabled = state.selectedTemplates.size === 0;
      }
    });
    selectWrap.appendChild(selectInput);

    const activeToggle = document.createElement("label");
    activeToggle.className = "toggle small";
    const activeInput = document.createElement("input");
    activeInput.type = "checkbox";
    activeInput.checked = template.active;
    const activeLabel = document.createElement("span");
    activeLabel.textContent = "Active";
    activeToggle.appendChild(activeInput);
    activeToggle.appendChild(activeLabel);

    const essentialToggle = document.createElement("label");
    essentialToggle.className = "toggle small";
    const essentialInput = document.createElement("input");
    essentialInput.type = "checkbox";
    essentialInput.checked = template.essential;
    const essentialLabel = document.createElement("span");
    essentialLabel.textContent = "Essential";
    essentialToggle.appendChild(essentialInput);
    essentialToggle.appendChild(essentialLabel);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = template.name;

    const categoryInput = document.createElement("input");
    categoryInput.type = "text";
    categoryInput.value = template.category || "";

    const amountInput = document.createElement("input");
    amountInput.type = "number";
    amountInput.min = "0";
    amountInput.step = "0.01";
    amountInput.value = Number(template.amount_default || 0).toFixed(2);

    const dueInput = document.createElement("input");
    dueInput.type = "number";
    dueInput.min = "1";
    dueInput.max = "31";
    dueInput.value = template.due_day;

    const autopayToggle = document.createElement("label");
    autopayToggle.className = "toggle small";
    const autopayInput = document.createElement("input");
    autopayInput.type = "checkbox";
    autopayInput.checked = template.autopay;
    const autopayLabel = document.createElement("span");
    autopayLabel.textContent = "Autopay";
    autopayToggle.appendChild(autopayInput);
    autopayToggle.appendChild(autopayLabel);

    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.value = template.default_note || "";

    const matchKeyInput = document.createElement("input");
    matchKeyInput.type = "text";
    matchKeyInput.value = template.match_payee_key || "";

    const matchToleranceInput = document.createElement("input");
    matchToleranceInput.type = "number";
    matchToleranceInput.min = "0";
    matchToleranceInput.step = "0.01";
    matchToleranceInput.value = Number(
      template.match_amount_tolerance || 0
    ).toFixed(2);

    const actions = document.createElement("div");
    actions.className = "actions";

    const saveBtn = document.createElement("button");
    saveBtn.className = "ghost-btn";
    saveBtn.textContent = "Save";
    saveBtn.disabled = true;

    const archiveBtn = document.createElement("button");
    archiveBtn.className = "ghost-btn";
    archiveBtn.textContent = "Archive";

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "ghost-btn";
    deleteBtn.textContent = "Delete";

    actions.appendChild(saveBtn);
    actions.appendChild(archiveBtn);
    actions.appendChild(deleteBtn);

    const initial = {
      active: template.active,
      essential: template.essential,
      name: template.name,
      category: template.category || "",
      amount_default: Number(template.amount_default || 0).toFixed(2),
      due_day: String(template.due_day),
      autopay: template.autopay,
      default_note: template.default_note || "",
      match_payee_key: template.match_payee_key || "",
      match_amount_tolerance: Number(template.match_amount_tolerance || 0).toFixed(2),
    };

    const checkDirty = () => {
      const dirty =
        activeInput.checked !== initial.active ||
        essentialInput.checked !== initial.essential ||
        nameInput.value !== initial.name ||
        categoryInput.value !== initial.category ||
        amountInput.value !== initial.amount_default ||
        dueInput.value !== initial.due_day ||
        autopayInput.checked !== initial.autopay ||
        noteInput.value !== initial.default_note ||
        matchKeyInput.value !== initial.match_payee_key ||
        matchToleranceInput.value !== initial.match_amount_tolerance;
      saveBtn.disabled = !dirty;
      return dirty;
    };

    [
      activeInput,
      essentialInput,
      nameInput,
      categoryInput,
      amountInput,
      dueInput,
      autopayInput,
      noteInput,
      matchKeyInput,
      matchToleranceInput,
    ].forEach((input) => {
      input.addEventListener("input", () => checkDirty());
      input.addEventListener("change", () => checkDirty());
    });

    saveBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      if (saveBtn.disabled) return;
      const payload = {
        name: nameInput.value.trim(),
        category: categoryInput.value.trim(),
        amount_default: Number(amountInput.value),
        due_day: Number(dueInput.value),
        autopay: autopayInput.checked,
        essential: essentialInput.checked,
        active: activeInput.checked,
        default_note: noteInput.value.trim(),
        match_payee_key: matchKeyInput.value.trim(),
        match_amount_tolerance: Number(matchToleranceInput.value || 0),
      };

      const res = await fetch(`/api/templates/${template.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let message = "Unable to save template.";
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
        } catch (err) {
          // ignore
        }
        window.alert(message);
        return;
      }

      await loadTemplates();
      renderTemplates();
    });

    archiveBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      await fetch(`/api/templates/${template.id}/archive`, { method: "POST" });
      await loadTemplates();
      renderTemplates();
    });

    deleteBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      const confirmed = window.confirm("Delete this template? This cannot be undone.");
      if (!confirmed) return;
      await fetch(`/api/templates/${template.id}`, { method: "DELETE" });
      await loadTemplates();
      renderTemplates();
    });

    row.appendChild(selectWrap);
    row.appendChild(activeToggle);
    row.appendChild(essentialToggle);
    row.appendChild(nameInput);
    row.appendChild(categoryInput);
    row.appendChild(amountInput);
    row.appendChild(dueInput);
    row.appendChild(autopayToggle);
    row.appendChild(noteInput);
    row.appendChild(matchKeyInput);
    row.appendChild(matchToleranceInput);
    row.appendChild(actions);

    els.templatesList.appendChild(row);

    state.templateRows.set(template.id, {
      initial,
      inputs: {
        activeInput,
        essentialInput,
        nameInput,
        categoryInput,
        amountInput,
        dueInput,
        autopayInput,
        noteInput,
        matchKeyInput,
        matchToleranceInput,
      },
      saveBtn,
      checkDirty,
    });
  });

  renderFundsList();
}

function buildTemplatePayload(entry) {
  const { inputs } = entry;
  return {
    name: inputs.nameInput.value.trim(),
    category: inputs.categoryInput.value.trim(),
    amount_default: Number(inputs.amountInput.value),
    due_day: Number(inputs.dueInput.value),
    autopay: inputs.autopayInput.checked,
    essential: inputs.essentialInput.checked,
    active: inputs.activeInput.checked,
    default_note: inputs.noteInput.value.trim(),
    match_payee_key: inputs.matchKeyInput.value.trim(),
    match_amount_tolerance: Number(inputs.matchToleranceInput.value || 0),
  };
}

function isTemplateDirty(entry) {
  return entry.checkDirty();
}

async function saveDirtyTemplates() {
  const dirtyEntries = [];
  for (const [id, entry] of state.templateRows.entries()) {
    if (isTemplateDirty(entry)) {
      dirtyEntries.push({ id, entry });
    }
  }
  if (dirtyEntries.length === 0) return 0;
  for (const { id, entry } of dirtyEntries) {
    const payload = buildTemplatePayload(entry);
    const res = await fetch(`/api/templates/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let message = "Unable to save template.";
      try {
        const data = await res.json();
        if (data?.error) message = data.error;
      } catch (err) {
        // ignore
      }
      window.alert(message);
      throw new Error(message);
    }
  }
  await loadTemplates();
  renderTemplates();
  return dirtyEntries.length;
}

function renderFundsList() {
  if (!els.fundsList) return;
  els.fundsList.innerHTML = "";
  if (!state.funds || state.funds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "Add a piggy bank to get started.";
    els.fundsList.appendChild(empty);
    return;
  }

  state.funds.forEach((fund) => {
    const row = document.createElement("div");
    row.className = "template-row";

    const activeToggle = document.createElement("label");
    activeToggle.className = "toggle small";
    const activeInput = document.createElement("input");
    activeInput.type = "checkbox";
    activeInput.checked = fund.active;
    const activeLabel = document.createElement("span");
    activeLabel.textContent = "Active";
    activeToggle.appendChild(activeInput);
    activeToggle.appendChild(activeLabel);

    const essentialToggle = document.createElement("label");
    essentialToggle.className = "toggle small";
    const essentialInput = document.createElement("input");
    essentialInput.type = "checkbox";
    essentialInput.checked = fund.essential;
    const essentialLabel = document.createElement("span");
    essentialLabel.textContent = "Essential";
    essentialToggle.appendChild(essentialInput);
    essentialToggle.appendChild(essentialLabel);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = fund.name;

    const categoryInput = document.createElement("input");
    categoryInput.type = "text";
    categoryInput.value = fund.category || "";

    const targetInput = document.createElement("input");
    targetInput.type = "number";
    targetInput.min = "0";
    targetInput.step = "0.01";
    targetInput.value = Number(fund.target_amount || 0).toFixed(2);

    const dueInput = document.createElement("input");
    dueInput.type = "date";
    dueInput.value = fund.due_date;

    const cadenceSelect = document.createElement("select");
    cadenceSelect.className = "select";
    ["yearly", "quarterly", "custom_months"].forEach((option) => {
      const opt = document.createElement("option");
      opt.value = option;
      opt.textContent = option.replace("_", " ");
      if (fund.cadence === option) opt.selected = true;
      cadenceSelect.appendChild(opt);
    });

    const monthsInput = document.createElement("input");
    monthsInput.type = "number";
    monthsInput.min = "1";
    monthsInput.step = "1";
    monthsInput.value = Number(fund.months_per_cycle || 1);
    monthsInput.disabled = fund.cadence !== "custom_months";

    cadenceSelect.addEventListener("change", () => {
      if (cadenceSelect.value === "custom_months") {
        monthsInput.disabled = false;
      } else {
        monthsInput.disabled = true;
        monthsInput.value = cadenceSelect.value === "quarterly" ? 3 : 12;
      }
    });

    const autoToggle = document.createElement("label");
    autoToggle.className = "toggle small";
    const autoInput = document.createElement("input");
    autoInput.type = "checkbox";
    autoInput.checked = fund.auto_contribute;
    const autoLabel = document.createElement("span");
    autoLabel.textContent = "Auto";
    autoToggle.appendChild(autoInput);
    autoToggle.appendChild(autoLabel);

    const actions = document.createElement("div");
    actions.className = "actions";

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn-small";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      await postAction({
        type: "UPDATE_FUND",
        fund_id: fund.id,
        name: nameInput.value,
        category: categoryInput.value,
        target_amount: Number(targetInput.value),
        due_date: dueInput.value,
        cadence: cadenceSelect.value,
        months_per_cycle: Number(monthsInput.value || 1),
        essential: essentialInput.checked,
        active: activeInput.checked,
        auto_contribute: autoInput.checked,
      });
      await refreshAll();
    });

    const archiveBtn = document.createElement("button");
    archiveBtn.className = "btn-small";
    archiveBtn.textContent = "Archive";
    archiveBtn.addEventListener("click", async () => {
      const confirmed = window.confirm("Archive this piggy bank?");
      if (!confirmed) return;
      await postAction({ type: "ARCHIVE_FUND", fund_id: fund.id });
      await refreshAll();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn-small";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      const confirmed = window.confirm("Delete this piggy bank? This cannot be undone.");
      if (!confirmed) return;
      await postAction({ type: "DELETE_FUND", fund_id: fund.id });
      await refreshAll();
    });

    actions.appendChild(saveBtn);
    actions.appendChild(archiveBtn);
    actions.appendChild(deleteBtn);

    row.appendChild(activeToggle);
    row.appendChild(essentialToggle);
    row.appendChild(nameInput);
    row.appendChild(categoryInput);
    row.appendChild(targetInput);
    row.appendChild(dueInput);
    row.appendChild(cadenceSelect);
    row.appendChild(monthsInput);
    row.appendChild(autoToggle);
    row.appendChild(actions);

    els.fundsList.appendChild(row);
  });
}

function renderDashboard() {
  const derived = deriveInstances();
  const base = getBaseInstances(derived);
  const summary = renderSummary(base);
  renderCash();
  renderZeroState();
  const { isFree } = renderStatus(summary, base);
  renderUrgency(base, isFree);
  renderPiggy();
  renderActivity();
  const events = buildNudgeEvents(base, summary, isFree);
  const key = JSON.stringify(events);
  if (key !== state.lastNudgeKey) {
    state.lastNudgeKey = key;
    fetchNudges(events);
  } else {
    renderNudges();
  }
  renderCategoryFilter(base);
  renderItems(base);
}

function renderView() {
  if (state.view === "dashboard") {
    els.dashboardView.classList.remove("hidden");
    els.templatesView.classList.add("hidden");
    els.navDashboard.classList.add("active");
    els.navTemplates.classList.remove("active");
  } else {
    els.templatesView.classList.remove("hidden");
    els.dashboardView.classList.add("hidden");
    els.navTemplates.classList.add("active");
    els.navDashboard.classList.remove("active");
  }
}

async function refreshAll() {
  await ensureMonth();
  await Promise.all([
    loadTemplates(),
    loadInstances(),
    loadPayments(),
    loadMonthSettings(),
    loadFunds(),
    loadQwenAuthStatus(),
  ]);
  renderDashboard();
  renderTemplates();
}

function bindEvents() {
  els.prevMonth.addEventListener("click", () => {
    let year = state.selectedYear;
    let month = state.selectedMonth - 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
    setMonth(year, month);
    refreshAll();
  });

  els.nextMonth.addEventListener("click", () => {
    let year = state.selectedYear;
    let month = state.selectedMonth + 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    setMonth(year, month);
    refreshAll();
  });

  els.monthPicker.addEventListener("change", () => {
    const { year, month } = parseMonthInput(els.monthPicker.value);
    if (year && month) {
      setMonth(year, month);
      refreshAll();
    }
  });

  els.essentialsToggle.addEventListener("change", () => {
    state.essentialsOnly = els.essentialsToggle.checked;
    renderDashboard();
  });

  els.navDashboard.addEventListener("click", () => {
    state.view = "dashboard";
    renderView();
  });

  els.navTemplates.addEventListener("click", () => {
    state.view = "templates";
    renderView();
  });

  els.backupOpen.addEventListener("click", () => {
    els.backupModal.classList.remove("hidden");
  });

  els.backupClose.addEventListener("click", () => {
    els.backupModal.classList.add("hidden");
  });

  if (els.openPiggyManage) {
    els.openPiggyManage.addEventListener("click", () => {
      state.view = "templates";
      renderView();
      document.getElementById("funds-section")?.scrollIntoView({ behavior: "smooth" });
    });
  }

  if (els.zeroIntakeBtn) {
    els.zeroIntakeBtn.addEventListener("click", () => {
      els.llmAgentInput?.focus();
      els.llmAgentInput?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  if (els.openIntake) {
    els.openIntake.addEventListener("click", () => {
      els.llmAgentInput?.focus();
      els.llmAgentInput?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  els.exportMonth.addEventListener("click", () => {
    const url = `/api/export/month.csv?year=${state.selectedYear}&month=${state.selectedMonth}`;
    window.open(url, "_blank");
  });

  els.exportBackup.addEventListener("click", async () => {
    const res = await fetch("/api/export/backup.json");
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `au_jour_le_jour_backup_${state.selectedYear}-${pad2(
      state.selectedMonth
    )}.json`;
    link.click();
    URL.revokeObjectURL(url);
  });

  els.importBackup.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const payload = JSON.parse(text);
      await fetch("/api/import/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await refreshAll();
    } catch (err) {
      window.alert("Invalid JSON backup file.");
    } finally {
      event.target.value = "";
    }
  });

  els.searchInput.addEventListener("input", () => {
    state.filters.search = els.searchInput.value.trim();
    renderDashboard();
  });

  document.querySelectorAll("[data-status]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const status = checkbox.dataset.status;
      state.filters.status[status] = checkbox.checked;
      renderDashboard();
    });
  });

  els.categoryFilter.addEventListener("change", () => {
    state.filters.category = els.categoryFilter.value;
    renderDashboard();
  });

  els.sortFilter.addEventListener("change", () => {
    state.filters.sort = els.sortFilter.value;
    renderDashboard();
  });

  if (els.cashStart) {
    els.cashStart.addEventListener("input", () => {
      const value = Number(els.cashStart.value);
      if (!Number.isFinite(value) || value < 0) {
        return;
      }
      state.cashStart = value;
      renderCash();
      markCashDirty(true);
      scheduleCashSave();
    });

    els.cashStart.addEventListener("blur", () => {
      const value = Number(els.cashStart.value);
      if (!Number.isFinite(value) || value < 0) {
        els.cashStart.value = state.cashStart.toFixed(2);
        return;
      }
      els.cashStart.value = value.toFixed(2);
    });
  }

  if (els.cashSave) {
    els.cashSave.addEventListener("click", async () => {
      setCashSaveStatus("Saving...");
      try {
        await saveMonthSettings(state.cashStart);
        setCashSaveStatus("Saved", "success");
        markCashDirty(false);
      } catch (err) {
        setCashSaveStatus("Save failed", "error");
      }
    });
  }

  els.templateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (els.templateError) {
      els.templateError.textContent = "";
      els.templateError.classList.add("hidden");
    }
    const payload = {
      name: els.templateName.value.trim(),
      category: els.templateCategory.value.trim(),
      amount_default: Number(els.templateAmount.value),
      due_day: Number(els.templateDueDay.value),
      autopay: els.templateAutopay.checked,
      essential: els.templateEssential.checked,
      active: els.templateActive.checked,
      default_note: els.templateNote.value.trim(),
      match_payee_key: els.templateMatchKey.value.trim(),
      match_amount_tolerance: Number(els.templateMatchTolerance.value || 0),
    };

    const res = await fetch("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      els.templateForm.reset();
      els.templateEssential.checked = true;
      els.templateActive.checked = true;
      await refreshAll();
    } else if (els.templateError) {
      let message = "Unable to add bill.";
      try {
        const data = await res.json();
        if (data?.error) message = data.error;
      } catch (err) {
        // ignore
      }
      els.templateError.textContent = message;
      els.templateError.classList.remove("hidden");
    }
  });

  if (els.applyTemplates) {
    els.applyTemplates.addEventListener("click", async () => {
    const confirmed = window.confirm(
      "Apply template values to this month? This will overwrite names, amounts, due dates, autopay, and essential flags for the selected month."
    );
    if (!confirmed) return;
    try {
      const dirtyCount = await saveDirtyTemplates();
      if (dirtyCount > 0) {
        const proceed = window.confirm(
          `Saved ${dirtyCount} template change(s). Apply to this month now?`
        );
        if (!proceed) return;
      }
    } catch (err) {
      return;
    }
    await fetch(
      `/api/apply-templates?year=${state.selectedYear}&month=${state.selectedMonth}`,
      { method: "POST" }
    );
    await refreshAll();
    });
  }

  if (els.selectAllTemplates) {
    els.selectAllTemplates.addEventListener("change", () => {
      if (els.selectAllTemplates.checked) {
        state.selectedTemplates = new Set(state.templates.map((t) => t.id));
      } else {
        state.selectedTemplates = new Set();
      }
      renderTemplates();
    });
  }

  if (els.archiveSelected) {
    els.archiveSelected.addEventListener("click", async () => {
      if (state.selectedTemplates.size === 0) return;
      const confirmed = window.confirm(
        `Archive ${state.selectedTemplates.size} template(s)?`
      );
      if (!confirmed) return;
      for (const id of state.selectedTemplates) {
        await fetch(`/api/templates/${id}/archive`, { method: "POST" });
      }
      state.selectedTemplates = new Set();
      await loadTemplates();
      renderTemplates();
    });
  }

  if (els.deleteSelected) {
    els.deleteSelected.addEventListener("click", async () => {
      if (state.selectedTemplates.size === 0) return;
      const confirmed = window.confirm(
        `Delete ${state.selectedTemplates.size} template(s)? This cannot be undone.`
      );
      if (!confirmed) return;
      for (const id of state.selectedTemplates) {
        await fetch(`/api/templates/${id}`, { method: "DELETE" });
      }
      state.selectedTemplates = new Set();
      await loadTemplates();
      renderTemplates();
    });
  }

  if (els.llmAgentSend) {
    els.llmAgentSend.addEventListener("click", () => {
      sendLlmAgent();
    });
  }

  if (els.llmAgentInput) {
    els.llmAgentInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendLlmAgent();
      }
    });
  }

  if (els.fundCadence && els.fundMonths) {
    els.fundCadence.addEventListener("change", () => {
      if (els.fundCadence.value === "custom_months") {
        els.fundMonths.disabled = false;
      } else {
        els.fundMonths.disabled = true;
        els.fundMonths.value = els.fundCadence.value === "quarterly" ? "3" : "12";
      }
    });
  }

  if (els.fundForm) {
    els.fundForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (els.fundError) {
        els.fundError.textContent = "";
        els.fundError.classList.add("hidden");
      }
      const res = await postAction({
        type: "CREATE_FUND",
        name: els.fundName?.value || "",
        category: els.fundCategory?.value || "",
        target_amount: Number(els.fundTarget?.value || 0),
        due_date: els.fundDueDate?.value || "",
        cadence: els.fundCadence?.value || "yearly",
        months_per_cycle: Number(els.fundMonths?.value || 1),
        essential: !!els.fundEssential?.checked,
        auto_contribute: !!els.fundAuto?.checked,
        active: !!els.fundActive?.checked,
      });
      if (!res.ok) {
        if (els.fundError) {
          els.fundError.textContent = res.error || "Unable to add fund.";
          els.fundError.classList.remove("hidden");
        }
        return;
      }
      if (els.fundForm) els.fundForm.reset();
      if (els.fundEssential) els.fundEssential.checked = true;
      if (els.fundAuto) els.fundAuto.checked = true;
      if (els.fundActive) els.fundActive.checked = true;
      if (els.fundCadence) els.fundCadence.value = "yearly";
      if (els.fundMonths) {
        els.fundMonths.value = "12";
        els.fundMonths.disabled = true;
      }
      await refreshAll();
    });
  }

  if (els.zeroTemplatesBtn) {
    els.zeroTemplatesBtn.addEventListener("click", () => {
      state.view = "templates";
      renderView();
    });
  }
}

function init() {
  const now = new Date();
  setMonth(now.getFullYear(), now.getMonth() + 1);
  state.essentialsOnly = els.essentialsToggle.checked;
  bindEvents();
  if (els.fundMonths && els.fundCadence && els.fundCadence.value !== "custom_months") {
    els.fundMonths.disabled = true;
  }
  refreshAll();
  setInterval(() => {
    if (!document.hidden) refreshAll();
  }, 60000);
  window.addEventListener("focus", () => refreshAll());
}

init();
