const state = {
  templates: [],
  instances: [],
  payments: [],
  funds: [],
  selectedTemplates: new Set(),
  settings: {
    defaults: { sort: "due_date", dueSoonDays: 7, defaultPeriod: "month" },
    categories: [],
  },
  nudges: [],
  lastNudgeKey: null,
  llmStatus: { status: "unknown", auth_url: null, error: null },
  llmChecked: false,
  qwenAuth: { connected: false, status: "unknown", session_id: null, verification_uri_complete: null, interval_seconds: null },
  llmHistory: [],
  commandLog: [],
  profileName: "",
  pendingAgentAction: null,
  monthLocked: false,
  lastAutoMonthKey: null,
  selectedYear: null,
  selectedMonth: null,
  essentialsOnly: true,
  view: "today",
  safeMode: false,
  safeReason: "",
  queueLaterCollapsed: true,
  templateRows: new Map(),
  filters: {
    search: "",
    status: "all",
    category: "all",
    sort: "due_date",
  },
  reviewRange: "month",
  selectedInstanceId: null,
  splitView: false,
  loading: false,
  instanceEvents: {},
  activityEvents: [],
};

const weeksPerMonth = 4.33;
const daysPerMonthAvg = 30.4;
let flashTimer = null;
let autoMonthTimer = null;
let refreshTimer = null;
let splitViewTimer = null;
let storageFailureHandled = false;
const MAX_LLM_INSTANCES = 60;
const MAX_LLM_TEMPLATES = 60;
const MAX_LLM_DUE = 8;
const AJL_WEB_MODE = !!window.AJL_WEB_MODE;
const PROFILE_NAME_KEY = "ajl_profile_name";
const PWA_DB_NAME = "ajl_pwa";
const PWA_DB_PREFIX = "ajl_pwa";

function looksLikeStorageError(err) {
  const message = String(err?.message || err || "");
  return message.includes("IDBKeyRange") || message.includes("DataError") || message.includes("IndexedDB");
}

function unwrapApiData(payload) {
  if (payload && typeof payload === "object" && payload.ok === true && "data" in payload) {
    return payload.data;
  }
  return payload;
}

async function readApiData(res) {
  const payload = await res.json().catch(() => null);
  return unwrapApiData(payload);
}

function getErrorMessage(data, fallback) {
  if (!data) return fallback;
  if (typeof data.error === "string") return data.error;
  if (data.error && typeof data.error.message === "string") return data.error.message;
  if (typeof data.message === "string") return data.message;
  return fallback;
}

let pwaResetInProgress = false;

async function resetPwaStorage() {
  if (!window.AJL_PWA) return;
  if (pwaResetInProgress) return;
  pwaResetInProgress = true;
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    }
    const deleteAll = async () => {
      try {
        const dbs = await indexedDB.databases?.();
        if (Array.isArray(dbs)) {
          await Promise.all(
            dbs
              .map((entry) => entry && entry.name)
              .filter((name) => typeof name === "string" && name.startsWith(PWA_DB_PREFIX))
              .map(
                (name) =>
                  new Promise((resolve) => {
                    const req = indexedDB.deleteDatabase(name);
                    req.onsuccess = () => resolve("success");
                    req.onerror = () => resolve("error");
                    req.onblocked = () => resolve("blocked");
                  })
              )
          );
          return "success";
        }
      } catch (err) {
        // ignore
      }
      return await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(PWA_DB_NAME);
        req.onsuccess = () => resolve("success");
        req.onerror = () => resolve("error");
        req.onblocked = () => resolve("blocked");
      });
    };
    const result = await deleteAll();
    if (result === "blocked") {
      window.alert("Reset blocked by another open tab. Close all Au Jour Le Jour tabs/windows and try again.");
      pwaResetInProgress = false;
      return;
    }
    try {
      window.localStorage.removeItem("ajl_pwa_db_name");
    } catch (err) {
      // ignore
    }
  } catch (err) {
    // ignore
  }
  setTimeout(() => {
    window.location.href = "/reset.html?force=1";
  }, 150);
}

function setupStorageRecovery() {
  window.addEventListener("unhandledrejection", (event) => {
    if (!looksLikeStorageError(event.reason)) return;
    event.preventDefault();
    if (pwaResetInProgress) return;
    const proceed = window.confirm("Local data appears corrupted. Reset local storage for this app?");
    if (proceed) resetPwaStorage();
  });
  window.addEventListener("error", (event) => {
    if (!looksLikeStorageError(event.error)) return;
    if (pwaResetInProgress) return;
    const proceed = window.confirm("Local data appears corrupted. Reset local storage for this app?");
    if (proceed) resetPwaStorage();
  });
}

function handleStorageFailure(err) {
  if (!looksLikeStorageError(err)) return false;
  if (AJL_WEB_MODE) {
    showSystemBanner("Web storage error. Use Setup → Reset local data.");
    return true;
  }
  if (storageFailureHandled) return true;
  storageFailureHandled = true;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  setTimeout(() => {
    const proceed = window.confirm("Local data appears corrupted. Reset local storage for this app?");
    if (proceed) resetPwaStorage();
  }, 0);
  return true;
}

function showSystemBanner(message) {
  if (!els.systemBanner) return;
  els.systemBanner.textContent = message;
  els.systemBanner.classList.remove("hidden");
}

function hideSystemBanner() {
  if (!els.systemBanner) return;
  els.systemBanner.classList.add("hidden");
}

let toastTimer = null;

function showToast(message, actionLabel, onAction) {
  if (!els.toast || !els.toastMessage || !els.toastAction) return;
  els.toastMessage.textContent = message;
  if (actionLabel && onAction) {
    els.toastAction.textContent = actionLabel;
    els.toastAction.classList.remove("hidden");
    els.toastAction.onclick = () => {
      onAction();
      hideToast();
    };
  } else {
    els.toastAction.classList.add("hidden");
    els.toastAction.onclick = null;
  }
  els.toast.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hideToast(), 5000);
}

function hideToast() {
  if (!els.toast) return;
  els.toast.classList.add("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
}

const els = {
  monthPicker: document.getElementById("month-picker"),
  prevMonth: document.getElementById("prev-month"),
  nextMonth: document.getElementById("next-month"),
  systemBanner: document.getElementById("system-banner"),
  essentialsToggle: document.getElementById("essentials-toggle"),
  navToday: document.getElementById("nav-today"),
  navReview: document.getElementById("nav-review"),
  navSetup: document.getElementById("nav-setup"),
  backupOpen: document.getElementById("open-backup"),
  backupModal: document.getElementById("backup-modal"),
  backupClose: document.getElementById("close-backup"),
  exportMonth: document.getElementById("export-month"),
  exportBackup: document.getElementById("export-backup"),
  importBackup: document.getElementById("import-backup"),
  resetLocal: document.getElementById("reset-local"),
  resetLocalInline: document.getElementById("reset-local-inline"),
  todayView: document.getElementById("today-view"),
  reviewView: document.getElementById("review-view"),
  setupView: document.getElementById("setup-view"),
  requiredAmount: document.getElementById("required-amount"),
  paidAmount: document.getElementById("paid-amount"),
  remainingAmount: document.getElementById("remaining-amount"),
  needDay: document.getElementById("need-day"),
  needWeek: document.getElementById("need-week"),
  needDayPlan: document.getElementById("need-day-plan"),
  needWeekPlan: document.getElementById("need-week-plan"),
  statusExpand: document.getElementById("status-expand"),
  statusBar: document.getElementById("status-bar"),
  statusPeriod: document.getElementById("status-period"),
  countRemaining: document.getElementById("count-remaining"),
  countOverdue: document.getElementById("count-overdue"),
  countSoon: document.getElementById("count-soon"),
  summarySheet: document.getElementById("summary-sheet"),
  summaryClose: document.getElementById("summary-close"),
  summaryCountRemaining: document.getElementById("summary-count-remaining"),
  summaryCountOverdue: document.getElementById("summary-count-overdue"),
  summaryCountSoon: document.getElementById("summary-count-soon"),
  summaryCountDone: document.getElementById("summary-count-done"),
  queueOverdue: document.getElementById("queue-overdue"),
  queueSoon: document.getElementById("queue-soon"),
  queueLater: document.getElementById("queue-later"),
  toggleLater: document.getElementById("toggle-later"),
  queueSubtitle: document.getElementById("queue-subtitle"),
  markAllOverdue: document.getElementById("mark-all-overdue"),
  recentStrip: document.getElementById("recent-strip"),
  itemsList: document.getElementById("items-list"),
  searchInput: document.getElementById("search-input"),
  statusChips: Array.from(document.querySelectorAll("#status-chips .chip")),
  filterOpen: document.getElementById("filter-open"),
  filterSheet: document.getElementById("filter-sheet"),
  filterClose: document.getElementById("filter-close"),
  filterStatusChips: Array.from(document.querySelectorAll("#filter-status .chip")),
  filterCategory: document.getElementById("filter-category"),
  filterSort: document.getElementById("filter-sort"),
  filterApply: document.getElementById("filter-apply"),
  categoryFilter: document.getElementById("category-filter"),
  sortFilter: document.getElementById("sort-filter"),
  zeroState: document.getElementById("zero-state"),
  zeroTemplatesBtn: document.getElementById("zero-templates-btn"),
  reviewActivityList: document.getElementById("review-activity-list"),
  reviewSummary: document.getElementById("review-summary"),
  reviewList: document.getElementById("review-list"),
  reviewFilters: Array.from(document.querySelectorAll("[data-review-range]")),
  defaultsPeriod: document.getElementById("defaults-period"),
  defaultsSort: document.getElementById("defaults-sort"),
  defaultsDueSoon: document.getElementById("defaults-due-soon"),
  saveDefaults: document.getElementById("save-defaults"),
  categoryInput: document.getElementById("category-input"),
  categoryAdd: document.getElementById("category-add"),
  categoriesList: document.getElementById("categories-list"),
  startSafeMode: document.getElementById("start-safe-mode"),
  templateForm: document.getElementById("template-form"),
  templateError: document.getElementById("template-error"),
  templateName: document.getElementById("template-name"),
  templateCategory: document.getElementById("template-category"),
  templateAmount: document.getElementById("template-amount"),
  templateDueDay: document.getElementById("template-due-day"),
  templateEssential: document.getElementById("template-essential"),
  templateActive: document.getElementById("template-active"),
  templateNote: document.getElementById("template-note"),
  templateMatchKey: document.getElementById("template-match-key"),
  templateMatchTolerance: document.getElementById("template-match-tolerance"),
  templatesList: document.getElementById("templates-list"),
  applyTemplates: document.getElementById("apply-templates"),
  selectAllTemplates: document.getElementById("select-all-templates"),
  archiveSelected: document.getElementById("archive-selected"),
  deleteSelected: document.getElementById("delete-selected"),
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
  detailsDrawer: document.getElementById("details-drawer"),
  detailsPane: document.getElementById("details-pane"),
  detailsPaneEmpty: document.getElementById("details-pane-empty"),
  detailName: document.getElementById("detail-name"),
  detailMeta: document.getElementById("detail-meta"),
  detailMarkDone: document.getElementById("detail-mark-done"),
  detailSkip: document.getElementById("detail-skip"),
  detailLogAmount: document.getElementById("detail-log-amount"),
  detailLogSubmit: document.getElementById("detail-log-submit"),
  detailLogStatus: document.getElementById("detail-log-status"),
  detailEditName: document.getElementById("detail-edit-name"),
  detailEditCategory: document.getElementById("detail-edit-category"),
  detailEditAmount: document.getElementById("detail-edit-amount"),
  detailEditDue: document.getElementById("detail-edit-due"),
  detailEditNote: document.getElementById("detail-edit-note"),
  detailSave: document.getElementById("detail-save"),
  detailSaveStatus: document.getElementById("detail-save-status"),
  detailHistory: document.getElementById("detail-history"),
  toast: document.getElementById("toast"),
  toastMessage: document.getElementById("toast-message"),
  toastAction: document.getElementById("toast-action"),
  assistantFab: document.getElementById("assistant-fab"),
  assistantDrawer: document.getElementById("assistant-drawer"),
  assistantConnection: document.getElementById("assistant-connection"),
  assistantConnectionTitle: document.getElementById("assistant-connection-title"),
  assistantConnectionBody: document.getElementById("assistant-connection-body"),
  assistantConnectionAction: document.getElementById("assistant-connection-action"),
  llmAgentInput: document.getElementById("llm-agent-input"),
  llmAgentSend: document.getElementById("llm-agent-send"),
  llmAgentOutput: document.getElementById("llm-agent-output"),
  llmAgentHistory: document.getElementById("llm-agent-history"),
  llmCommandLog: document.getElementById("llm-command-log"),
  llmAgentActions: document.getElementById("llm-agent-actions"),
  llmAgentConfirm: document.getElementById("llm-agent-confirm"),
  llmAgentCancel: document.getElementById("llm-agent-cancel"),
  llmChatClear: document.getElementById("llm-chat-clear"),
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

function parseMoney(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === "number") return value;
  const raw = String(value).trim();
  if (!raw) return NaN;
  const cleaned = raw.replace(/,/g, "");
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return NaN;
  return Number(match[0]);
}

function loadProfileName() {
  try {
    return localStorage.getItem(PROFILE_NAME_KEY) || "";
  } catch (err) {
    return "";
  }
}

function saveProfileName(name) {
  try {
    localStorage.setItem(PROFILE_NAME_KEY, name);
  } catch (err) {
    // ignore
  }
}

function getTimeGreeting() {
  const hour = new Date().getHours();
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function updateAssistantGreeting() {
  if (!els.assistantGreeting) return;
  const name = state.profileName ? `, ${state.profileName}` : "";
  els.assistantGreeting.textContent = `${getTimeGreeting()}${name}.`;
}

function focusAgentInput({ scroll = false } = {}) {
  if (!els.llmAgentInput) return;
  if (scroll && els.assistantDrawer) {
    els.assistantDrawer.classList.remove("hidden");
  }
  els.llmAgentInput.focus({ preventScroll: !scroll });
}

function resolvePaymentAmount(payload, instance) {
  if (!payload) return NaN;
  let mode = String(payload.amount_mode || "").toUpperCase();
  let fraction = payload.fraction;
  const amountField = payload.amount;
  const amountText = amountField != null ? String(amountField).toLowerCase() : "";

  if (mode === "HALF") {
    mode = "FRACTION";
    fraction = 0.5;
  }
  if (mode === "FULL" || mode === "REMAINING") {
    mode = "FULL_REMAINING";
  }
  if (!mode && amountText) {
    if (amountText.includes("half")) {
      mode = "FRACTION";
      fraction = 0.5;
    } else if (amountText.includes("full") || amountText.includes("remaining")) {
      mode = "FULL_REMAINING";
    } else if (amountText.includes("%")) {
      const perc = parseMoney(amountText);
      if (Number.isFinite(perc)) {
        mode = "FRACTION";
        fraction = perc / 100;
      }
    }
  }

  if (mode === "FULL_REMAINING") {
    return Number(instance?.amount_remaining || 0);
  }
  if (mode === "FRACTION") {
    const frac = Number(fraction);
    if (Number.isFinite(frac)) {
      return Number(instance?.amount_remaining || 0) * frac;
    }
  }
  return parseMoney(amountField);
}

function formatShortDate(dateString) {
  if (!dateString) return "";
  const date = new Date(`${dateString}T00:00:00`);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatChangeValue(field, value) {
  if (value == null) return "—";
  if (field === "amount") return formatMoney(value);
  if (field === "due_date") return formatShortDate(value);
  return String(value);
}

function getRowHeight() {
  return window.innerWidth >= 1024 ? 64 : 56;
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

function getQueryFlags() {
  const params = new URLSearchParams(window.location.search);
  return {
    reset: params.get("reset") === "1",
    safe: params.get("safe") === "1",
  };
}

function updateQuery(params) {
  const url = new URL(window.location.href);
  url.search = params.toString();
  window.history.replaceState({}, "", url.toString());
}

function checkCrashGuard() {
  try {
    const key = "ajl_boot_guard";
    const now = Date.now();
    const raw = sessionStorage.getItem(key);
    if (!raw) {
      sessionStorage.setItem(key, JSON.stringify({ count: 1, ts: now }));
      return false;
    }
    const parsed = JSON.parse(raw);
    const delta = now - (parsed.ts || 0);
    const count = delta < 10000 ? (parsed.count || 0) + 1 : 1;
    sessionStorage.setItem(key, JSON.stringify({ count, ts: now }));
    return count >= 3;
  } catch (err) {
    return false;
  }
}

function setMonth(year, month) {
  state.selectedYear = year;
  state.selectedMonth = month;
  els.monthPicker.value = `${year}-${pad2(month)}`;
}

function setMonthWithLock(year, month, lock = true) {
  setMonth(year, month);
  state.monthLocked = lock;
  if (lock && isCurrentMonth(year, month)) {
    state.monthLocked = false;
  }
  if (!state.monthLocked) {
    state.lastAutoMonthKey = `${year}-${pad2(month)}`;
  }
}

function enterSafeMode(reason) {
  state.safeMode = true;
  state.safeReason = reason || "Safe mode enabled.";
  showSystemBanner(`Safe mode: ${state.safeReason} Use Setup → Reset local data or refresh without ?safe=1.`);
}

async function handleResetFlag() {
  const flags = getQueryFlags();
  if (!flags.reset) return false;
  try {
    await fetch("/api/reset-local", { method: "POST" });
  } catch (err) {
    // ignore
  }
  const params = new URLSearchParams(window.location.search);
  params.delete("reset");
  updateQuery(params);
  window.location.reload();
  return true;
}

function syncToCurrentMonth() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const currentKey = `${year}-${pad2(month)}`;
  const selectedKey = `${state.selectedYear}-${pad2(state.selectedMonth)}`;

  if (selectedKey === currentKey) {
    state.lastAutoMonthKey = currentKey;
    return false;
  }

  if (!state.monthLocked || state.lastAutoMonthKey === selectedKey) {
    setMonth(year, month);
    state.monthLocked = false;
    state.lastAutoMonthKey = currentKey;
    return true;
  }

  return false;
}

async function ensureMonth() {
  await fetch(`/api/ensure-month?year=${state.selectedYear}&month=${state.selectedMonth}`);
}

async function loadTemplates() {
  const res = await fetch("/api/templates");
  const data = await readApiData(res);
  state.templates = Array.isArray(data) ? data : [];
}

async function loadInstances() {
  const res = await fetch(
    `/api/instances?year=${state.selectedYear}&month=${state.selectedMonth}`
  );
  const data = await readApiData(res);
  state.instances = Array.isArray(data) ? data : [];
}

async function loadPayments() {
  const res = await fetch(
    `/api/payments?year=${state.selectedYear}&month=${state.selectedMonth}`
  );
  const data = await readApiData(res);
  state.payments = Array.isArray(data) ? data : [];
}

async function loadInstanceEvents(instanceId) {
  if (!instanceId) return [];
  const res = await fetch(`/api/instances/${instanceId}/events`);
  const data = await readApiData(res);
  const events = Array.isArray(data) ? data : [];
  state.instanceEvents[instanceId] = events;
  return events;
}

async function loadActivityEvents() {
  const res = await fetch(`/api/instance-events?year=${state.selectedYear}&month=${state.selectedMonth}`);
  const data = await readApiData(res);
  state.activityEvents = Array.isArray(data) ? data : [];
}

async function loadFunds() {
  const res = await fetch(
    `/api/sinking-funds?year=${state.selectedYear}&month=${state.selectedMonth}&include_inactive=1`
  );
  const data = await readApiData(res);
  state.funds = Array.isArray(data) ? data : [];
}

async function loadSettings() {
  const res = await fetch("/api/settings");
  const data = await readApiData(res);
  if (data && typeof data === "object") {
    const defaults = data.defaults || state.settings.defaults;
    const categories = Array.isArray(data.categories) ? data.categories : [];
    state.settings = {
      defaults: {
        sort: defaults.sort || "due_date",
        dueSoonDays: Number(defaults.dueSoonDays || 7),
        defaultPeriod: defaults.defaultPeriod || "month",
      },
      categories,
    };
    state.filters.sort = state.settings.defaults.sort || state.filters.sort;
    if (els.sortFilter) els.sortFilter.value = state.filters.sort;
  }
}

async function loadQwenAuthStatus() {
  if (AJL_WEB_MODE) {
    state.qwenAuth = { connected: false, status: "disabled", session_id: null, verification_uri_complete: null, interval_seconds: null };
    return;
  }
  try {
    const res = await fetch("/api/llm/qwen/oauth/status");
    if (!res.ok) return;
    const data = await res.json();
    if (data.disabled) {
      state.qwenAuth = {
        connected: false,
        status: "disabled",
        session_id: null,
        verification_uri_complete: null,
        interval_seconds: null,
      };
      return;
    }
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
  try {
    const res = await fetch("/api/llm/qwen/oauth/start", { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      state.qwenAuth.status = "error";
      state.qwenAuth.error = data.error || "Unable to start Mamdou auth.";
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
  } catch (err) {
    state.qwenAuth.status = "error";
    state.qwenAuth.error = err.message || "Unable to start Mamdou auth.";
    renderNudges();
  }
}

function stopQwenPolling() {
  if (qwenPollTimer) {
    clearTimeout(qwenPollTimer);
    qwenPollTimer = null;
  }
}

async function pollQwenAuth() {
  if (!state.qwenAuth.session_id) return;
  try {
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
  } catch (err) {
    state.qwenAuth.status = "error";
    state.qwenAuth.error = err.message || "OAuth error";
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
  return readApiData(res);
}

async function logAgentCommand(entry) {
  try {
    await fetch("/internal/agent/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry || {}),
    });
  } catch (err) {
    // ignore log errors
  }
}

async function loadCommandLog() {
  if (AJL_WEB_MODE) {
    state.commandLog = [];
    renderCommandLog();
    return;
  }
  if (!els.llmCommandLog) return;
  try {
    const res = await fetch("/internal/agent/log?limit=12");
    if (!res.ok) return;
    const data = await res.json();
    state.commandLog = Array.isArray(data.items) ? data.items : [];
    renderCommandLog();
  } catch (err) {
    // ignore
  }
}

async function loadChatHistory() {
  if (AJL_WEB_MODE) {
    state.llmHistory = [];
    renderLlmHistory();
    return;
  }
  try {
    const res = await fetch("/api/chat?limit=50");
    if (!res.ok) return;
    const data = await res.json();
    state.llmHistory = Array.isArray(data.items)
      ? data.items.map((item) => ({ role: item.role, text: item.text, meta: item.meta || "" }))
      : [];
    renderLlmHistory();
  } catch (err) {
    // ignore
  }
}

async function saveChatMessage(role, text, meta = "") {
  try {
    await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, text, meta }),
    });
  } catch (err) {
    // ignore
  }
}

async function clearChatHistory() {
  try {
    await fetch("/api/chat", { method: "DELETE" });
  } catch (err) {
    // ignore
  }
  state.llmHistory = [];
  renderLlmHistory();
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
    window.alert(data.error || "Unable to log update.");
    return;
  }
  const data = await res.json();
  if (data.instance) updateInstanceInState(data.instance);
  flashRow(instanceId);
  await loadPayments();
  await loadActivityEvents();
  renderDashboard();
}

async function markPaid(instanceId, options = {}) {
  const result = await postAction({
    type: "MARK_PAID",
    instance_id: instanceId,
    paid_date: getTodayDateString(),
  });
  if (!result || result.ok === false) {
    window.alert(getErrorMessage(result, "Unable to mark done."));
    return;
  }
  if (result.instance) updateInstanceInState(result.instance);
  await loadPayments();
  await loadActivityEvents();
  renderDashboard();
  if (!options.silent) {
    showToast("Marked done.", "Undo", () => markPending(instanceId));
  }
}

async function markPending(instanceId) {
  const result = await postAction({
    type: "MARK_PENDING",
    instance_id: instanceId,
  });
  if (!result || result.ok === false) {
    window.alert(getErrorMessage(result, "Unable to undo."));
    return;
  }
  if (result.instance) updateInstanceInState(result.instance);
  await loadPayments();
  await loadActivityEvents();
  renderDashboard();
}

function flashRow(instanceId) {
  state.flashInstanceId = instanceId;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    const el = document.querySelector(`.item-row[data-id="${instanceId}"]`);
    if (el) el.classList.remove("row-flash");
    state.flashInstanceId = null;
  }, 650);
}

async function undoPayment(paymentId) {
  const res = await fetch(`/api/payments/${paymentId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    window.alert(data.error || "Unable to undo update.");
    return;
  }
  const data = await res.json();
  if (data.instance) updateInstanceInState(data.instance);
  await loadPayments();
  await loadActivityEvents();
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
  await loadActivityEvents();
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

function prioritizeInstancesForAgent(list) {
  const today = getTodayDateString();
  const scored = list.map((item) => {
    const remaining = Number(item.amount_remaining || 0);
    let priority = 2;
    if (item.status_derived === "skipped") priority = 4;
    if (remaining <= 0) priority = 3;
    if (remaining > 0 && item.due_date < today) priority = 0;
    else if (remaining > 0 && diffDays(item.due_date, today) <= 7) priority = 1;
    return { item, priority, remaining };
  });
  scored.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.item.due_date !== b.item.due_date) return a.item.due_date.localeCompare(b.item.due_date);
    return b.remaining - a.remaining;
  });
  return scored.map((entry) => entry.item);
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
    overdue: overdue.slice(0, MAX_LLM_DUE).map((item) => ({
      name: item.name_snapshot,
      remaining: item.amount_remaining,
      due_date: item.due_date,
    })),
    due_soon: dueSoon.slice(0, MAX_LLM_DUE).map((item) => ({
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
  const prioritized = prioritizeInstancesForAgent(base);
  const knownInstances = prioritized.slice(0, MAX_LLM_INSTANCES).map((item) => ({
    name: item.name_snapshot,
    remaining: item.amount_remaining,
    status: item.status_derived,
    due_date: item.due_date,
  }));
  const knownTemplates = state.templates.slice(0, MAX_LLM_TEMPLATES).map((t) => ({
    name: t.name,
    active: t.active,
  }));
  const knownFunds = (state.funds || []).slice(0, MAX_LLM_TEMPLATES).map((f) => ({
    name: f.name,
    due_date: f.due_date,
    target_amount: f.target_amount,
    balance: f.balance,
    status: f.status,
    active: f.active,
  }));
  const nameMap = new Map(state.instances.map((inst) => [inst.id, inst.name_snapshot]));
  const recentPayments = (state.payments || []).slice(0, 10).map((p) => ({
    id: p.id,
    name: nameMap.get(p.instance_id) || "Update",
    amount: p.amount,
    paid_date: p.paid_date,
  }));
  return {
    user_text: userText,
    period: `${state.selectedYear}-${pad2(state.selectedMonth)}`,
    context: buildLlmContext(),
    known_instances: knownInstances,
    known_templates: knownTemplates,
    known_funds: knownFunds,
    recent_payments: recentPayments,
  };
}

function renderSummary(list) {
  const totals = computeTotals(list);
  const daysInMonth = getDaysInMonth(state.selectedYear, state.selectedMonth);
  const needDailyExact = totals.required / daysInMonth;
  const needWeeklyExact = needDailyExact * 7;
  const needDailyPlan = totals.required / daysPerMonthAvg;
  const needWeeklyPlan = totals.required / weeksPerMonth;
  const today = getTodayDateString();
  const currentMonth = isCurrentMonth(state.selectedYear, state.selectedMonth);
  const remainingItems = list.filter((item) => item.status_derived !== "skipped" && item.amount_remaining > 0);
  const overdue = remainingItems.filter((item) => currentMonth && item.due_date < today);
  const dueSoonDays = Number(state.settings.defaults?.dueSoonDays || 7);
  const soonCutoff = new Date();
  soonCutoff.setDate(soonCutoff.getDate() + Math.max(1, dueSoonDays));
  const soonCutoffString = `${soonCutoff.getFullYear()}-${pad2(soonCutoff.getMonth() + 1)}-${pad2(soonCutoff.getDate())}`;
  const dueSoon = remainingItems.filter((item) => currentMonth && item.due_date >= today && item.due_date <= soonCutoffString);
  const doneCount = list.filter((item) => item.status_derived === "paid" || item.amount_remaining <= 0).length;

  els.requiredAmount.textContent = formatMoney(totals.required);
  els.paidAmount.textContent = formatMoney(totals.paid);
  els.remainingAmount.textContent = formatMoney(totals.remaining);
  els.needDay.textContent = formatMoney(needDailyExact);
  els.needWeek.textContent = formatMoney(needWeeklyExact);
  els.needDayPlan.textContent = `Planning avg: ${formatMoney(needDailyPlan)}/day`;
  els.needWeekPlan.textContent = `Planning avg: ${formatMoney(needWeeklyPlan)}/week`;

  if (els.summaryCountRemaining) els.summaryCountRemaining.textContent = remainingItems.length;
  if (els.summaryCountOverdue) els.summaryCountOverdue.textContent = overdue.length;
  if (els.summaryCountSoon) els.summaryCountSoon.textContent = dueSoon.length;
  if (els.summaryCountDone) els.summaryCountDone.textContent = doneCount;

  return { ...totals, daysInMonth };
}

function renderZeroState() {
  if (!els.zeroState) return;
  if (state.templates.length === 0) {
    els.zeroState.classList.remove("hidden");
  } else {
    els.zeroState.classList.add("hidden");
  }
}

function renderStatusBar(baseList) {
  if (!els.countRemaining || !els.countOverdue || !els.countSoon) return;
  const today = getTodayDateString();
  const currentMonth = isCurrentMonth(state.selectedYear, state.selectedMonth);
  const remaining = baseList.filter((item) => item.status_derived !== "skipped" && item.amount_remaining > 0);
  const overdue = remaining.filter((item) => currentMonth && item.due_date < today);
  const soonCutoff = new Date();
  const dueSoonDays = Number(state.settings.defaults?.dueSoonDays || 7);
  soonCutoff.setDate(soonCutoff.getDate() + Math.max(1, dueSoonDays));
  const soonCutoffString = `${soonCutoff.getFullYear()}-${pad2(soonCutoff.getMonth() + 1)}-${pad2(soonCutoff.getDate())}`;
  const dueSoon = remaining.filter((item) => currentMonth && item.due_date >= today && item.due_date <= soonCutoffString);

  els.countRemaining.textContent = remaining.length;
  els.countOverdue.textContent = overdue.length;
  els.countSoon.textContent = dueSoon.length;

  if (els.statusPeriod) {
    const label = `${new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(new Date(state.selectedYear, state.selectedMonth - 1, 1))}`;
    els.statusPeriod.textContent = `Period: ${label}`;
  }
}

function renderActionQueue(baseList) {
  if (!els.queueOverdue || !els.queueSoon || !els.queueLater) return;
  els.queueOverdue.innerHTML = "";
  els.queueSoon.innerHTML = "";
  els.queueLater.innerHTML = "";

  const today = getTodayDateString();
  const currentMonth = isCurrentMonth(state.selectedYear, state.selectedMonth);
  const dueSoonDays = Number(state.settings.defaults?.dueSoonDays || 7);
  const soonCutoff = new Date();
  soonCutoff.setDate(soonCutoff.getDate() + Math.max(1, dueSoonDays));
  const soonCutoffString = `${soonCutoff.getFullYear()}-${pad2(soonCutoff.getMonth() + 1)}-${pad2(soonCutoff.getDate())}`;

  const remaining = baseList.filter((item) => item.status_derived !== "skipped" && item.amount_remaining > 0);
  const overdue = remaining.filter((item) => currentMonth && item.due_date < today);
  const dueSoon = remaining.filter((item) => currentMonth && item.due_date >= today && item.due_date <= soonCutoffString);
  const later = remaining.filter((item) => !currentMonth || item.due_date > soonCutoffString);

  if (els.queueSubtitle) {
    els.queueSubtitle.textContent = `Overdue: ${overdue.length} items`;
  }
  if (els.markAllOverdue) {
    els.markAllOverdue.disabled = overdue.length === 0;
  }

  const renderQueueRow = (item) => {
    const row = document.createElement("div");
    row.className = "queue-row";
    const main = document.createElement("div");
    main.className = "item-main";
    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = item.name_snapshot;
    const meta = document.createElement("div");
    meta.className = "item-sub";
    meta.textContent = `Due ${formatShortDate(item.due_date)}`;
    main.appendChild(title);
    main.appendChild(meta);

    const right = document.createElement("div");
    right.className = "item-meta";
    const amount = document.createElement("div");
    amount.className = "item-amount";
    amount.textContent = formatMoney(item.amount_remaining);
    const kebab = document.createElement("button");
    kebab.className = "ghost-btn small";
    kebab.textContent = "…";
    kebab.setAttribute("aria-label", "Open details");
    kebab.addEventListener("click", (event) => {
      event.stopPropagation();
      openInstanceDetail(item.id);
    });
    const action = document.createElement("button");
    action.className = "btn-small btn-primary";
    action.textContent = "Mark done";
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      markPaid(item.id);
    });
    right.appendChild(amount);
    right.appendChild(kebab);
    right.appendChild(action);

    row.appendChild(main);
    row.appendChild(right);
    row.addEventListener("click", () => openInstanceDetail(item.id));
    return row;
  };

  const renderEmpty = (target) => {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "Nothing here.";
    target.appendChild(empty);
  };

  if (overdue.length === 0) renderEmpty(els.queueOverdue);
  else overdue.forEach((item) => els.queueOverdue.appendChild(renderQueueRow(item)));

  if (dueSoon.length === 0) renderEmpty(els.queueSoon);
  else dueSoon.forEach((item) => els.queueSoon.appendChild(renderQueueRow(item)));

  if (later.length === 0) renderEmpty(els.queueLater);
  else later.forEach((item) => els.queueLater.appendChild(renderQueueRow(item)));

  if (els.toggleLater) {
    const hasLater = later.length > 0;
    els.toggleLater.classList.toggle("hidden", !hasLater);
    els.queueLater.classList.toggle("hidden", state.queueLaterCollapsed);
    els.toggleLater.textContent = state.queueLaterCollapsed ? "Show" : "Hide";
  }
}

function renderRecentStrip() {
  if (!els.recentStrip) return;
  const items = (state.payments || [])
    .slice()
    .sort((a, b) => String(b.paid_date).localeCompare(String(a.paid_date)))
    .slice(0, 3);
  if (items.length === 0) {
    els.recentStrip.classList.add("hidden");
    return;
  }
  const instanceMap = new Map(state.instances.map((inst) => [inst.id, inst.name_snapshot]));
  const entries = items.map((event) => {
    const name = instanceMap.get(event.instance_id) || "Item";
    return `${name} · ${formatShortDate(event.paid_date)}`;
  });
  els.recentStrip.textContent = `Recent: ${entries.join(" · ")}`;
  els.recentStrip.classList.remove("hidden");
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

function formatStatusLabel(status) {
  if (status === "paid") return "Done";
  if (status === "partial") return "Partial";
  if (status === "skipped") return "Skipped";
  return "Pending";
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
  const piggyCta = els.piggyCta;
  if (activeFunds.length === 0) {
    if (els.piggyCard) els.piggyCard.classList.add("hidden");
    if (piggyCta) piggyCta.classList.remove("hidden");
    return;
  }
  if (els.piggyCard) els.piggyCard.classList.remove("hidden");
  if (piggyCta) piggyCta.classList.add("hidden");

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
    paidBtn.textContent = "Mark done";
    paidBtn.addEventListener("click", () => handleMarkFundPaid(fund.id));

    const editBtn = document.createElement("button");
    editBtn.className = "btn-small";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      state.view = "setup";
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
  if (!els.reviewActivityList) return;
  els.reviewActivityList.innerHTML = "";
  const events = state.activityEvents || [];
  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "No activity yet.";
    els.reviewActivityList.appendChild(empty);
    return;
  }

  const filtered = events.filter((event) => {
    if (state.reviewRange === "today") {
      return String(event.created_at || "").startsWith(getTodayDateString());
    }
    if (state.reviewRange === "week") {
      const date = String(event.created_at || "").slice(0, 10);
      const diff = diffDays(date, getTodayDateString());
      return diff <= 7;
    }
    return true;
  });

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "No activity yet.";
    els.reviewActivityList.appendChild(empty);
    return;
  }

  const describeEvent = (event) => {
    const time = formatDateTime(event.created_at);
    if (event.type === "created") return { title: `Created · ${event.name || "Item"}`, meta: time };
    if (event.type === "marked_done") return { title: `Marked done · ${event.name || "Item"}`, meta: time };
    if (event.type === "log_update") return { title: `Logged update · ${event.name || "Item"}`, meta: time };
    if (event.type === "update_removed") return { title: `Update removed · ${event.name || "Item"}`, meta: time };
    if (event.type === "skipped") return { title: `Marked skipped · ${event.name || "Item"}`, meta: time };
    if (event.type === "unskipped") return { title: `Unskipped · ${event.name || "Item"}`, meta: time };
    if (event.type === "status_changed") return { title: `Status changed · ${event.name || "Item"}`, meta: time };
    if (event.type === "note_updated") return { title: `Note updated · ${event.name || "Item"}`, meta: time };
    if (event.type === "edited") return { title: `Edited · ${event.name || "Item"}`, meta: time };
    return { title: `Updated · ${event.name || "Item"}`, meta: time };
  };

  filtered.slice(0, 50).forEach((event) => {
    const row = document.createElement("div");
    row.className = "list-row";
    const left = document.createElement("div");
    left.className = "list-main";
    const title = document.createElement("div");
    title.className = "item-title";
    const meta = document.createElement("div");
    meta.className = "item-sub";
    const desc = describeEvent(event);
    title.textContent = desc.title;
    meta.textContent = desc.meta;
    left.appendChild(title);
    left.appendChild(meta);
    row.appendChild(left);
    const paymentId = event.detail?.payment_id;
    if (paymentId) {
      const undo = document.createElement("button");
      undo.className = "ghost-btn";
      undo.textContent = "Undo";
      undo.addEventListener("click", () => undoPayment(paymentId));
      row.appendChild(undo);
    }
    els.reviewActivityList.appendChild(row);
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
        body: "Mark done or log an update.",
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
  if (AJL_WEB_MODE) {
    state.nudges = [];
    renderNudges();
    return;
  }
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
        state.llmStatus = { status: "unavailable", auth_url: null, error: data.error || "Mamdou unavailable" };
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
    state.llmStatus = { status: "unavailable", auth_url: null, error: err.message || "Mamdou unavailable" };
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
  saveChatMessage(role, text, meta);
}

function renderCommandLog() {
  if (!els.llmCommandLog) return;
  els.llmCommandLog.innerHTML = "";
  const list = Array.isArray(state.commandLog) ? state.commandLog : [];
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "assistant-log-empty";
    empty.textContent = "No commands logged yet.";
    els.llmCommandLog.appendChild(empty);
    return;
  }
  list.forEach((entry) => {
    const row = document.createElement("div");
    row.className = `assistant-log-row ${entry.status === "error" ? "error" : "ok"}`;

    const title = document.createElement("div");
    title.className = "assistant-log-title";
    title.textContent = entry.summary || entry.user_text || "Command";

    const meta = document.createElement("div");
    meta.className = "assistant-log-meta";
    const when = entry.created_at ? formatShortDate(entry.created_at.slice(0, 10)) : "";
    meta.textContent = `${entry.status === "error" ? "Failed" : "Executed"}${when ? ` · ${when}` : ""}`;

    row.appendChild(title);
    row.appendChild(meta);
    els.llmCommandLog.appendChild(row);
  });
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
  const targetName = proposal.target?.name || proposal.payload?.name || "";
  let instance = null;
  let template = null;
  let fund = null;

  if (proposal.target?.type === "instance") {
    instance = findInstanceByName(targetName, base);
  } else if (proposal.target?.type === "template") {
    template = findTemplateByName(targetName);
  } else if (proposal.target?.type === "fund") {
    fund = findFundByName(targetName);
  }

  const intent = String(proposal.intent || proposal.action || "").toUpperCase();

  if (!template && intent && intent.includes("TEMPLATE")) {
    template = findTemplateByName(targetName);
  }
  if (!fund && intent && (intent.includes("FUND") || intent.includes("SINKING"))) {
    fund = findFundByName(targetName);
  }
  if (!instance && !template && !fund && targetName) {
    instance = findInstanceByName(targetName, base);
  }

  if (!instance && intent && intent.startsWith("SHOW_")) {
    if (intent === "SHOW_DUE_SOON") {
      document.getElementById("queue-soon")?.scrollIntoView({ behavior: "smooth" });
    } else if (intent === "SHOW_OVERDUE") {
      document.getElementById("queue-overdue")?.scrollIntoView({ behavior: "smooth" });
    } else if (intent === "SHOW_TEMPLATES") {
      state.view = "setup";
      renderView();
    } else if (intent === "SHOW_PIGGY") {
      state.view = "setup";
      renderView();
      document.getElementById("funds-section")?.scrollIntoView({ behavior: "smooth" });
    } else if (intent === "SHOW_BACKUP") {
      els.backupOpen?.click();
    } else if (intent === "SHOW_SUMMARY" || intent === "SHOW_DASHBOARD") {
      state.view = "today";
      renderView();
      els.summarySheet?.classList.remove("hidden");
    } else {
      els.summarySheet?.classList.remove("hidden");
    }
    return { ok: true, message: "Opened the requested section." };
  }

  if (intent === "SET_MONTH") {
    const period = proposal.target?.period || "";
    let year = state.selectedYear;
    let month = state.selectedMonth;
    if (period && /^\d{4}-\d{2}$/.test(period)) {
      year = Number(period.slice(0, 4));
      month = Number(period.slice(5));
    } else if (proposal.payload?.year && proposal.payload?.month) {
      year = Number(proposal.payload.year);
      month = Number(proposal.payload.month);
    }
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
      return { ok: false, message: "Invalid month." };
    }
    setMonthWithLock(year, month, true);
    await refreshAll();
    return { ok: true, message: `Switched to ${year}-${pad2(month)}.` };
  }
  if (intent === "SET_ESSENTIALS_ONLY") {
    const value = proposal.payload?.essentials_only;
    if (value === undefined) {
      state.essentialsOnly = !state.essentialsOnly;
    } else {
      state.essentialsOnly = Boolean(value);
    }
    if (els.essentialsToggle) els.essentialsToggle.checked = state.essentialsOnly;
    renderDashboard();
    return { ok: true, message: `Essentials only: ${state.essentialsOnly ? "on" : "off"}.` };
  }
  if (intent === "EXPORT_MONTH") {
    els.exportMonth?.click();
    return { ok: true, message: "Exported month CSV." };
  }
  if (intent === "EXPORT_BACKUP") {
    els.exportBackup?.click();
    return { ok: true, message: "Exported backup JSON." };
  }
  if (intent === "GENERATE_MONTH") {
    const period = proposal.target?.period || "";
    let year = state.selectedYear;
    let month = state.selectedMonth;
    if (period && /^\d{4}-\d{2}$/.test(period)) {
      year = Number(period.slice(0, 4));
      month = Number(period.slice(5));
    } else if (proposal.payload?.year && proposal.payload?.month) {
      year = Number(proposal.payload.year);
      month = Number(proposal.payload.month);
    }
    await postAction({ type: "GENERATE_MONTH", year, month });
    await refreshAll();
    return { ok: true, message: "Month generated." };
  }
  if (intent === "APPLY_TEMPLATES") {
    await fetch(
      `/api/apply-templates?year=${state.selectedYear}&month=${state.selectedMonth}`,
      { method: "POST" }
    );
    await refreshAll();
    return { ok: true, message: "Applied templates to this month." };
  }

  if (intent === "SET_CASH_START") {
    return { ok: false, message: "Tracking is not available in tracker mode." };
  }

  if (intent === "CREATE_TEMPLATE") {
    const payload = proposal.payload || {};
    const name = payload.name || proposal.target?.name;
    const amountValue = payload.amount_default ?? payload.amount ?? payload.amount_due;
    const amount = parseMoney(amountValue);
    const dueDayRaw = parseMoney(payload.due_day);
    const dueDay = Number.isFinite(dueDayRaw) ? dueDayRaw : 1;
    if (!name || !Number.isFinite(amount)) {
      return { ok: false, message: "Missing template details." };
    }
    const result = await postAction({
      type: "CREATE_TEMPLATE",
      name,
      category: payload.category || null,
      amount_default: amount,
      due_day: dueDay,
      essential: payload.essential !== false,
      autopay: !!payload.autopay,
      active: payload.active !== false,
      default_note: payload.default_note || null,
      match_payee_key: payload.match_payee_key || null,
      match_amount_tolerance: Number(payload.match_amount_tolerance || 5),
      year: state.selectedYear,
      month: state.selectedMonth,
    });
    if (!result?.ok) {
      return { ok: false, message: result?.error || "Template not created." };
    }
    await refreshAll();
    return { ok: true, message: "Template created." };
  }

  if (intent === "UPDATE_TEMPLATE") {
    if (!template) return { ok: false, message: "Template not found." };
    const parsedAmount = proposal.payload?.amount_default ?? proposal.payload?.amount;
    const amountDefault = Number.isFinite(parseMoney(parsedAmount))
      ? parseMoney(parsedAmount)
      : template.amount_default;
    const parsedTolerance = proposal.payload?.match_amount_tolerance;
    const matchTolerance = Number.isFinite(parseMoney(parsedTolerance))
      ? parseMoney(parsedTolerance)
      : template.match_amount_tolerance ?? 5;
    const payload = {
      name: template.name,
      category: template.category || null,
      amount_default: amountDefault,
      due_day: template.due_day,
      essential: template.essential,
      autopay: template.autopay,
      active: template.active,
      default_note: template.default_note || null,
      match_payee_key: template.match_payee_key || null,
      match_amount_tolerance: matchTolerance,
      ...(proposal.payload || {}),
    };
    payload.amount_default = amountDefault;
    payload.match_amount_tolerance = matchTolerance;
    if (payload.due_day !== undefined && payload.due_day !== null) {
      const parsedDue = parseMoney(payload.due_day);
      if (Number.isFinite(parsedDue)) payload.due_day = Math.round(parsedDue);
    }
    await postAction({
      type: "UPDATE_TEMPLATE",
      template_id: template.id,
      year: state.selectedYear,
      month: state.selectedMonth,
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

  if (intent === "DELETE_TEMPLATE") {
    if (!template) return { ok: false, message: "Template not found." };
    await postAction({
      type: "DELETE_TEMPLATE",
      template_id: template.id,
      year: state.selectedYear,
      month: state.selectedMonth,
    });
    await refreshAll();
    return { ok: true, message: "Template deleted." };
  }

  if (intent === "CREATE_FUND") {
    const payload = proposal.payload || {};
    const name = payload.name || proposal.target?.name;
    const targetAmount = parseMoney(payload.target_amount);
    if (!name || !Number.isFinite(targetAmount) || !payload.due_date) {
      return { ok: false, message: "Missing fund details." };
    }
    await postAction({
      type: "CREATE_FUND",
      name,
      category: payload.category || null,
      target_amount: targetAmount,
      due_date: payload.due_date,
      cadence: payload.cadence || "yearly",
      months_per_cycle: Number(payload.months_per_cycle || 12),
      essential: payload.essential !== false,
      auto_contribute: payload.auto_contribute !== false,
      active: payload.active !== false,
    });
    await refreshAll();
    return { ok: true, message: "Reserved bucket created." };
  }

  if (intent === "UPDATE_FUND") {
    if (!fund) return { ok: false, message: "Reserved bucket not found." };
    const parsedTarget = proposal.payload?.target_amount;
    const targetAmount = Number.isFinite(parseMoney(parsedTarget))
      ? parseMoney(parsedTarget)
      : fund.target_amount;
    await postAction({
      type: "UPDATE_FUND",
      fund_id: fund.id,
      name: proposal.payload?.name ?? fund.name,
      category: proposal.payload?.category ?? fund.category,
      target_amount: targetAmount,
      due_date: proposal.payload?.due_date ?? fund.due_date,
      cadence: proposal.payload?.cadence ?? fund.cadence,
      months_per_cycle: proposal.payload?.months_per_cycle ?? fund.months_per_cycle,
      essential: proposal.payload?.essential ?? fund.essential,
      auto_contribute: proposal.payload?.auto_contribute ?? fund.auto_contribute,
      active: proposal.payload?.active ?? fund.active,
    });
    await refreshAll();
    return { ok: true, message: "Reserved bucket updated." };
  }

  if (intent === "ARCHIVE_FUND") {
    if (!fund) return { ok: false, message: "Reserved bucket not found." };
    await postAction({ type: "ARCHIVE_FUND", fund_id: fund.id });
    await refreshAll();
    return { ok: true, message: "Reserved bucket archived." };
  }

  if (intent === "DELETE_FUND") {
    if (!fund) return { ok: false, message: "Reserved bucket not found." };
    await postAction({ type: "DELETE_FUND", fund_id: fund.id });
    await refreshAll();
    return { ok: true, message: "Reserved bucket deleted." };
  }

  if (intent === "ADD_SINKING_EVENT") {
    if (!fund) return { ok: false, message: "Reserved bucket not found." };
    const amount = parseMoney(proposal.payload?.amount);
    const eventType = String(proposal.payload?.event_type || proposal.payload?.type || "").toUpperCase();
    if (!amount || !eventType) {
      return { ok: false, message: "Missing reserved bucket event details." };
    }
    await postAction({
      type: "ADD_SINKING_EVENT",
      fund_id: fund.id,
      event_type: eventType,
      amount,
      note: proposal.payload?.note || null,
    });
    await refreshAll();
    return { ok: true, message: "Reserved bucket event added." };
  }

  if (intent === "MARK_FUND_PAID") {
    if (!fund) return { ok: false, message: "Reserved bucket not found." };
    await postAction({
      type: "MARK_FUND_PAID",
      fund_id: fund.id,
      amount: Number.isFinite(parseMoney(proposal.payload?.amount))
        ? parseMoney(proposal.payload?.amount)
        : proposal.payload?.amount,
    });
    await refreshAll();
    return { ok: true, message: "Reserved bucket marked done." };
  }

  if (!instance) {
    return { ok: false, message: "Could not resolve the target bill." };
  }
  if (intent === "UNDO_PAYMENT") {
    const paymentId = proposal.payload?.payment_id;
    let targetPaymentId = paymentId;
    if (!targetPaymentId) {
      const latest = (state.payments || []).find((p) => p.instance_id === instance.id);
      targetPaymentId = latest?.id;
    }
    if (!targetPaymentId) {
      return { ok: false, message: "No recent update found to undo." };
    }
    await postAction({ type: "UNDO_PAYMENT", payment_id: targetPaymentId });
    await refreshAll();
    return { ok: true, message: "Update undone." };
  }
  if (intent === "MARK_PAID") {
    await postAction({
      type: "MARK_PAID",
      instance_id: instance.id,
      paid_date: proposal.payload?.paid_date || todayDate(),
    });
  } else if (intent === "MARK_PENDING") {
    await postAction({ type: "MARK_PENDING", instance_id: instance.id });
  } else if (intent === "SKIP_INSTANCE") {
    await postAction({ type: "SKIP_INSTANCE", instance_id: instance.id });
  } else if (intent === "ADD_PAYMENT") {
    const amount = resolvePaymentAmount(proposal.payload || {}, instance);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, message: "Invalid update amount." };
    }
    await postAction({ type: "ADD_PAYMENT", instance_id: instance.id, amount });
  } else if (intent === "UPDATE_INSTANCE_FIELDS") {
    await postAction({
      type: "UPDATE_INSTANCE_FIELDS",
      instance_id: instance.id,
      name_snapshot: proposal.payload?.name_snapshot ?? proposal.payload?.name,
      category_snapshot: proposal.payload?.category_snapshot ?? proposal.payload?.category,
      amount: Number.isFinite(parseMoney(proposal.payload?.amount))
        ? parseMoney(proposal.payload?.amount)
        : proposal.payload?.amount,
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
  const skippedNames = [];
  for (const template of templates) {
    const name = String(template.name || "").trim();
    const amountValue = template.amount_default ?? template.amount ?? template.amount_due ?? template.value;
    const amount = parseMoney(amountValue);
    if (!name || !Number.isFinite(amount) || amount < 0) {
      skipped += 1;
      if (name) skippedNames.push(name);
      continue;
    }
    if (existingNames.has(name.toLowerCase())) {
      skipped += 1;
      skippedNames.push(name);
      continue;
    }
    const dueDay = parseMoney(template.due_day_guess);
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
    const result = await postAction(payload);
    if (!result?.ok) {
      skipped += 1;
      skippedNames.push(name);
      continue;
    }
    existingNames.add(name.toLowerCase());
    created += 1;
  }
  await refreshAll();
  const skippedLabel = skipped > 0 ? ` Skipped ${skipped}: ${skippedNames.slice(0, 5).join(", ")}.` : "";
  return {
    created,
    skipped,
    message: created > 0 ? `Saved ${created} templates.${skippedLabel}` : `No templates were saved.${skippedLabel}`,
  };
}

async function sendLlmAgent() {
  if (!els.llmAgentInput || !els.llmAgentOutput) return;
  if (AJL_WEB_MODE) {
    els.llmAgentOutput.textContent = "Mamdou is available in the local app only.";
    pushLlmMessage("assistant", "Mamdou is available in the local app only.");
    return;
  }
  if (state.qwenAuth && state.qwenAuth.status === "disabled") {
    els.llmAgentOutput.textContent = "Mamdou is available in the local app only.";
    return;
  }
  if (state.qwenAuth && !state.qwenAuth.connected) {
    els.llmAgentOutput.textContent = "Connect Mamdou first.";
    return;
  }
  if (state.pendingAgentAction) {
    els.llmAgentOutput.textContent = "Confirm or cancel the pending action first.";
    return;
  }
  const text = els.llmAgentInput.value.trim();
  if (!text) return;
  els.llmAgentOutput.textContent = "Thinking...";
  pushLlmMessage("user", text);
  els.llmAgentInput.value = "";
  focusAgentInput();

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
        state.llmStatus = { status: "unavailable", auth_url: null, error: data?.error || "Mamdou unavailable" };
      }
      renderNudges();
      els.llmAgentOutput.textContent = data?.error || "Mamdou unavailable.";
      pushLlmMessage("assistant", "Mamdou unavailable.", data?.error || "");
      return;
    }

    const result = data?.data || {};
    const kind = String(result.kind || "").toLowerCase();
    const proposals = Array.isArray(result.proposals) ? result.proposals : [];
    const pickProposal = () => {
      if (result.proposal) return result.proposal;
      if (proposals.length === 0) return null;
      return proposals
        .slice()
        .sort((a, b) => (Number(b?.confidence) || 0) - (Number(a?.confidence) || 0))[0];
    };
    if (kind === "ask") {
      const answer = result.answer || "No response.";
      els.llmAgentOutput.textContent = "";
      pushLlmMessage("assistant", answer);
      focusAgentInput();
      return;
    }

    if (kind === "command" || proposals.length > 0 || result.proposal) {
      const proposal = pickProposal();
      if (proposal?.clarifying_question) {
        els.llmAgentOutput.textContent = "";
        pushLlmMessage("assistant", proposal.clarifying_question);
        focusAgentInput();
        return;
      }
      if (proposal?.intent && proposal.intent.startsWith("SHOW_")) {
        const outcome = await applyProposal(proposal);
        els.llmAgentOutput.textContent = "";
        pushLlmMessage("assistant", outcome.message);
        focusAgentInput();
        return;
      }
      const summary = summarizeProposal(proposal);
      setPendingAgentAction({ kind: "command", proposal, summary, source_text: text });
      els.llmAgentOutput.textContent = `${summary}. Confirm to proceed.`;
      pushLlmMessage("assistant", `${summary}. Waiting for confirmation.`);
      focusAgentInput();
      return;
    }

    if (kind === "intake" || Array.isArray(result.templates)) {
      const questions = result.questions || [];
      const warnings = result.warnings || [];
      if (questions.length > 0) {
        const questionText = questions.map((q) => q.question).join(" ");
        els.llmAgentOutput.textContent = "";
        pushLlmMessage("assistant", questionText || "Need more details.");
        focusAgentInput();
        return;
      }
      const templates = result.templates || [];
      const summary = summarizeIntake(templates);
      setPendingAgentAction({ kind: "intake", templates, warnings, summary, source_text: text });
      const warningText = warnings.length > 0 ? warnings.join(" ") : "";
      els.llmAgentOutput.textContent = `${summary}. Confirm to proceed.`;
      pushLlmMessage("assistant", `${summary}. Waiting for confirmation.`);
      if (warningText) {
        pushLlmMessage("assistant", warningText);
      }
      focusAgentInput();
      return;
    }

    const errors = Array.isArray(result.errors) ? result.errors : [];
    if (errors.length > 0) {
      els.llmAgentOutput.textContent = "";
      pushLlmMessage("assistant", errors.join(" "));
      focusAgentInput();
      return;
    }
    if (result.answer) {
      els.llmAgentOutput.textContent = "";
      pushLlmMessage("assistant", result.answer);
      focusAgentInput();
      return;
    }
    els.llmAgentOutput.textContent = "";
    pushLlmMessage("assistant", "No response.");
    focusAgentInput();
  } catch (err) {
    els.llmAgentOutput.textContent = "Mamdou unavailable.";
    pushLlmMessage("assistant", "Mamdou unavailable.");
    focusAgentInput();
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

function findFundByName(name) {
  if (!name) return null;
  const target = name.toLowerCase();
  const exact = (state.funds || []).find((f) => f.name.toLowerCase() === target);
  if (exact) return exact;
  const partial = (state.funds || []).find((f) => f.name.toLowerCase().includes(target));
  return partial || null;
}

function summarizeIntake(templates) {
  if (!Array.isArray(templates) || templates.length === 0) {
    return "No templates to create.";
  }
  const names = templates.map((t) => t.name).filter(Boolean);
  const preview = names.slice(0, 5).join(", ");
  const suffix = names.length > 5 ? "…" : "";
  return `Create ${templates.length} template(s): ${preview}${suffix}`;
}

function setPendingAgentAction(action) {
  state.pendingAgentAction = action;
  if (els.llmAgentActions) els.llmAgentActions.classList.remove("hidden");
}

function clearPendingAgentAction() {
  state.pendingAgentAction = null;
  if (els.llmAgentActions) els.llmAgentActions.classList.add("hidden");
}

function summarizeProposal(proposal) {
  if (!proposal) return "No proposal.";
  const intent = String(proposal.intent || proposal.action || "UNKNOWN").toUpperCase();
  const target = proposal.target?.name || proposal.payload?.name || "Unknown";
  if (intent === "MARK_PAID") return `Mark done: ${target}`;
  if (intent === "SKIP_INSTANCE") return `Skip: ${target}`;
  if (intent === "MARK_PENDING") return `Mark pending: ${target}`;
  if (intent === "ADD_PAYMENT") {
    const mode = proposal.payload?.amount_mode || "FIXED";
    if (mode === "FULL_REMAINING") return `Mark done: ${target}`;
    if (mode === "FRACTION") return `Log ${proposal.payload?.fraction || 0} progress: ${target}`;
    return `Log update for ${target}`;
  }
  if (intent === "UPDATE_INSTANCE_FIELDS") return `Update bill: ${target}`;
  if (intent === "CREATE_TEMPLATE") return `Create template: ${target}`;
  if (intent === "UPDATE_TEMPLATE") return `Update template: ${target}`;
  if (intent === "ARCHIVE_TEMPLATE") return `Archive template: ${target}`;
  if (intent === "DELETE_TEMPLATE") return `Delete template: ${target}`;
  if (intent === "APPLY_TEMPLATES") return "Apply templates to this month";
  if (intent === "CREATE_FUND") return `Create reserved bucket: ${target}`;
  if (intent === "UPDATE_FUND") return `Update reserved bucket: ${target}`;
  if (intent === "ARCHIVE_FUND") return `Archive reserved bucket: ${target}`;
  if (intent === "DELETE_FUND") return `Delete reserved bucket: ${target}`;
  if (intent === "ADD_SINKING_EVENT") return `Add reserved bucket event: ${target}`;
  if (intent === "MARK_FUND_PAID") return `Mark reserved bucket done: ${target}`;
  if (intent === "SET_CASH_START") return "Tracking removed";
  if (intent === "EXPORT_MONTH") return "Export current month CSV";
  if (intent === "EXPORT_BACKUP") return "Export full backup JSON";
  if (intent === "GENERATE_MONTH") return "Generate month";
  if (intent === "UNDO_PAYMENT") return `Undo update: ${target}`;
  if (intent === "SET_MONTH") return "Switch month";
  if (intent === "SET_ESSENTIALS_ONLY") return "Toggle essentials only";
  if (intent === "SHOW_SUMMARY") return "Show Today";
  return `Intent: ${intent}`;
}

function renderAssistantConnection() {
  if (!els.assistantConnection || !els.assistantConnectionTitle || !els.assistantConnectionBody || !els.assistantConnectionAction) {
    return;
  }
  if (AJL_WEB_MODE) {
    els.assistantConnectionTitle.textContent = "Mamdou unavailable";
    els.assistantConnectionBody.textContent = "Mamdou is available in the local app only.";
    els.assistantConnectionAction.innerHTML = "";
    return;
  }
  const actionWrap = els.assistantConnectionAction;
  actionWrap.innerHTML = "";

  const status = state.qwenAuth?.status || "unknown";
  const connected = !!state.qwenAuth?.connected;
  const authUrl = state.qwenAuth?.verification_uri_complete || state.llmStatus?.auth_url || null;
  const errorText = state.qwenAuth?.error || state.llmStatus?.error || "";

  let title = "Connect Mamdou";
  let body = "Use Mamdou login to enable insights.";
  let action = null;

  if (status === "disabled") {
    title = "Mamdou unavailable";
    body = "Use the local app to connect Mamdou.";
  } else if (connected) {
    title = "Agent connected";
    body = "Mamdou is ready.";
  } else if (status === "pending" && authUrl) {
    title = "Authorize Mamdou";
    body = "Authorize in browser, then return here.";
    action = { type: "link", label: "Open login", href: authUrl };
  } else if (state.llmStatus?.status === "auth_required" && authUrl) {
    title = "Mamdou login required";
    body = "Complete device authorization.";
    action = { type: "link", label: "Complete login", href: authUrl };
  } else if (status === "expired") {
    title = "Login expired";
    body = "Start Mamdou login again.";
    action = { type: "button", label: "Start login", onClick: startQwenAuth };
  } else if (status === "error") {
    title = "Mamdou error";
    body = errorText || "Unable to start Mamdou auth.";
    action = { type: "button", label: "Retry", onClick: startQwenAuth };
  } else if (!connected) {
    action = { type: "button", label: "Start login", onClick: startQwenAuth };
  }

  els.assistantConnectionTitle.textContent = title;
  els.assistantConnectionBody.textContent = body;

  if (action) {
    if (action.type === "link") {
      const link = document.createElement("a");
      link.className = "btn-small";
      link.href = action.href;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = action.label;
      actionWrap.appendChild(link);
    } else {
      const btn = document.createElement("button");
      btn.className = "btn-small";
      btn.textContent = action.label;
      btn.addEventListener("click", action.onClick);
      actionWrap.appendChild(btn);
    }
  }
}


function renderNudges() {
  renderAssistantConnection();
  if (!els.nudgesList) return;
  els.nudgesList.innerHTML = "";
  let hasStatusRow = false;

  if (state.qwenAuth && state.qwenAuth.status === "disabled") {
    const row = document.createElement("div");
    row.className = "list-item";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Mamdou unavailable on web";
    const body = document.createElement("div");
    body.className = "meta";
    body.textContent = "Use the local app to connect Mamdou.";
    left.appendChild(title);
    left.appendChild(body);
    row.appendChild(left);
    els.nudgesList.appendChild(row);
    hasStatusRow = true;
  } else if (state.qwenAuth && !state.qwenAuth.connected) {
    const row = document.createElement("div");
    row.className = "list-item";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Connect Mamdou";
    const body = document.createElement("div");
    body.className = "meta";
    if (state.qwenAuth.status === "pending" && state.qwenAuth.verification_uri_complete) {
      body.textContent = "Authorize in browser, then return here.";
    } else if (state.qwenAuth.status === "error") {
      body.textContent = state.qwenAuth.error || "Unable to start Mamdou auth.";
    } else if (state.qwenAuth.status === "expired") {
      body.textContent = "Login expired. Start again.";
    } else {
      body.textContent = "Use Mamdou login to enable insights.";
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
    title.textContent = "Mamdou ready.";
    const body = document.createElement("div");
    body.className = "meta";
    body.textContent = "";
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
    title.textContent = "Mamdou error";
    const body = document.createElement("div");
    body.className = "meta";
    body.textContent = state.llmStatus.error || "Mamdou unavailable.";
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
    title.textContent = "Mamdou login required";
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
    title.textContent = "Mamdou unavailable";
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
      empty.textContent = "No insights right now.";
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
    document.getElementById("queue-overdue")?.scrollIntoView({ behavior: "smooth" });
  } else if (cta.action_type === "OPEN_DUE_SOON") {
    document.getElementById("queue-soon")?.scrollIntoView({ behavior: "smooth" });
  } else if (cta.action_type === "OPEN_TEMPLATES") {
    state.view = "setup";
    renderView();
  } else {
    els.summarySheet?.classList.remove("hidden");
  }
}


function renderCategoryFilter(list) {
  const categories = new Set();
  list.forEach((item) => {
    if (item.category_snapshot) categories.add(item.category_snapshot);
  });
  (state.settings.categories || []).forEach((cat) => {
    if (cat) categories.add(cat);
  });

  const current = state.filters.category;
  els.categoryFilter.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All categories";
  els.categoryFilter.appendChild(allOption);

  if (els.filterCategory) {
    els.filterCategory.innerHTML = "";
    const sheetAll = document.createElement("option");
    sheetAll.value = "all";
    sheetAll.textContent = "All categories";
    els.filterCategory.appendChild(sheetAll);
  }

  Array.from(categories)
    .sort((a, b) => a.localeCompare(b))
    .forEach((cat) => {
      const option = document.createElement("option");
      option.value = cat;
      option.textContent = cat;
      if (cat === current) option.selected = true;
      els.categoryFilter.appendChild(option);

      if (els.filterCategory) {
        const sheetOpt = document.createElement("option");
        sheetOpt.value = cat;
        sheetOpt.textContent = cat;
        els.filterCategory.appendChild(sheetOpt);
      }
    });

  if (!categories.has(current)) {
    state.filters.category = "all";
  }
}

function syncFilterSheet() {
  if (els.filterSort) els.filterSort.value = state.filters.sort;
  if (els.filterCategory) els.filterCategory.value = state.filters.category;
  if (els.filterStatusChips && els.filterStatusChips.length > 0) {
    els.filterStatusChips.forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.status === state.filters.status);
    });
  }
}

function openFilterSheet() {
  if (!els.filterSheet) return;
  syncFilterSheet();
  els.filterSheet.classList.remove("hidden");
}

function closeFilterSheet() {
  if (!els.filterSheet) return;
  els.filterSheet.classList.add("hidden");
}

function renderDefaults() {
  if (!els.defaultsSort || !els.defaultsDueSoon || !els.defaultsPeriod) return;
  els.defaultsSort.value = state.settings.defaults.sort || "due_date";
  els.defaultsDueSoon.value = state.settings.defaults.dueSoonDays || 7;
  els.defaultsPeriod.value = state.settings.defaults.defaultPeriod || "month";
}

function renderCategories() {
  if (!els.categoriesList) return;
  els.categoriesList.innerHTML = "";
  const categories = Array.from(new Set((state.settings.categories || []).filter(Boolean)));
  if (categories.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "No categories yet.";
    els.categoriesList.appendChild(empty);
    return;
  }
  categories.sort((a, b) => a.localeCompare(b)).forEach((cat) => {
    const pill = document.createElement("div");
    pill.className = "category-pill";
    const label = document.createElement("span");
    label.textContent = cat;
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${cat}`);
    remove.addEventListener("click", () => {
      removeCategory(cat);
    });
    pill.appendChild(label);
    pill.appendChild(remove);
    els.categoriesList.appendChild(pill);
  });
}

async function saveSettings(updates) {
  const payload = {
    defaults: state.settings.defaults,
    categories: state.settings.categories,
    ...updates,
  };
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await readApiData(res);
  if (data && typeof data === "object") {
    state.settings.defaults = data.defaults || state.settings.defaults;
    state.settings.categories = Array.isArray(data.categories) ? data.categories : state.settings.categories;
  }
}

async function addCategory() {
  if (!els.categoryInput) return;
  const value = String(els.categoryInput.value || "").trim();
  if (!value) return;
  const next = new Set(state.settings.categories || []);
  next.add(value);
  state.settings.categories = Array.from(next);
  await saveSettings({ categories: state.settings.categories });
  els.categoryInput.value = "";
  renderCategories();
  renderCategoryFilter(state.instances || []);
}

async function removeCategory(category) {
  const next = (state.settings.categories || []).filter((cat) => cat !== category);
  state.settings.categories = next;
  await saveSettings({ categories: next });
  renderCategories();
  renderCategoryFilter(state.instances || []);
}

function renderItems(baseList) {
  const filters = state.filters;
  let list = baseList.slice();

  if (filters.status !== "all") {
    list = list.filter((item) => item.status_derived === filters.status);
  }

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
    if (filters.sort === "amount") return Number(a.amount) - Number(b.amount);
    if (filters.sort === "name") return a.name_snapshot.localeCompare(b.name_snapshot);
    if (filters.sort === "status") return a.status_derived.localeCompare(b.status_derived);
    const dueCompare = a.due_date.localeCompare(b.due_date);
    if (dueCompare !== 0) return dueCompare;
    return a.name_snapshot.localeCompare(b.name_snapshot);
  });

  els.itemsList.innerHTML = "";

  if (state.loading && list.length === 0) {
    const skeletonWrap = document.createElement("div");
    skeletonWrap.className = "items-skeleton";
    const rows = window.innerWidth >= 1024 ? 8 : 6;
    for (let i = 0; i < rows; i += 1) {
      const sk = document.createElement("div");
      sk.className = "skeleton-row";
      skeletonWrap.appendChild(sk);
    }
    els.itemsList.appendChild(skeletonWrap);
    return;
  }

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
  const rowHeight = getRowHeight();

  const buildRow = (item) => {
    const row = document.createElement("div");
    row.className = `item-row status-${item.status_derived}`;
    row.dataset.id = item.id;

    if (currentMonth && item.amount_remaining > 0) {
      const daysUntil = diffDays(item.due_date, today);
      if (daysUntil < 0) row.classList.add("status-overdue");
      else if (daysUntil <= 7) row.classList.add("status-soon");
    }

    const main = document.createElement("div");
    main.className = "item-main";
    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = item.name_snapshot;
    const sub = document.createElement("div");
    sub.className = "item-sub";
    const category = item.category_snapshot ? ` · ${item.category_snapshot}` : "";
    sub.textContent = `Due ${formatShortDate(item.due_date)}${category}`;
    main.appendChild(title);
    main.appendChild(sub);

    const right = document.createElement("div");
    right.className = "item-meta";
    const amount = document.createElement("div");
    amount.className = "item-amount";
    amount.textContent = formatMoney(item.amount);
    const pill = document.createElement("div");
    pill.className = `status-pill ${item.status_derived === "paid" ? "done" : item.status_derived}`;
    pill.textContent = formatStatusLabel(item.status_derived);
    right.appendChild(amount);
    right.appendChild(pill);
    if (item.status_derived !== "paid" && item.status_derived !== "skipped") {
      const doneBtn = document.createElement("button");
      doneBtn.className = "btn-small btn-primary";
      doneBtn.textContent = "Mark done";
      doneBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        markPaid(item.id);
      });
      right.appendChild(doneBtn);
    }

    row.appendChild(main);
    row.appendChild(right);
    row.addEventListener("click", () => openInstanceDetail(item.id));
    return row;
  };

  const scroll = document.createElement("div");
  scroll.className = "items-scroll";
  const spacer = document.createElement("div");
  spacer.className = "items-spacer";
  spacer.style.height = `${list.length * rowHeight}px`;
  const inner = document.createElement("div");
  inner.className = "items-inner";
  scroll.appendChild(spacer);
  scroll.appendChild(inner);
  els.itemsList.appendChild(scroll);

  const renderWindow = () => {
    const scrollTop = scroll.scrollTop;
    const height = scroll.clientHeight || 400;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 5);
    const end = Math.min(list.length, Math.ceil((scrollTop + height) / rowHeight) + 5);
    inner.style.transform = `translateY(${start * rowHeight}px)`;
    inner.innerHTML = "";
    for (let i = start; i < end; i += 1) {
      inner.appendChild(buildRow(list[i]));
    }
  };

  scroll.addEventListener("scroll", renderWindow);
  renderWindow();
}

async function renderDetailHistory(instanceId) {
  if (!els.detailHistory) return;
  els.detailHistory.innerHTML = "";
  const events = await loadInstanceEvents(instanceId);
  if (!events || events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "No updates yet.";
    els.detailHistory.appendChild(empty);
    return;
  }

  const describeEvent = (event) => {
    const detail = event.detail || {};
    const time = formatDateTime(event.created_at);
    if (event.type === "created") return { title: "Created", meta: time };
    if (event.type === "marked_done") {
      const amount = detail.amount ? formatMoney(detail.amount) : "";
      return { title: "Marked done", meta: `${amount}`.trim() ? `${amount} · ${time}` : time };
    }
    if (event.type === "log_update") {
      const amount = detail.amount ? formatMoney(detail.amount) : "";
      return { title: `Logged update ${amount}`.trim(), meta: time };
    }
    if (event.type === "update_removed") {
      const amount = detail.amount ? formatMoney(detail.amount) : "";
      return { title: `Update removed ${amount}`.trim(), meta: time };
    }
    if (event.type === "skipped") {
      return { title: "Marked skipped", meta: time };
    }
    if (event.type === "unskipped") {
      return { title: "Unskipped", meta: time };
    }
    if (event.type === "status_changed") {
      const meta = detail.from && detail.to ? `${detail.from} → ${detail.to} · ${time}` : time;
      return { title: "Status changed", meta };
    }
    if (event.type === "note_updated") {
      return { title: "Note updated", meta: time };
    }
    if (event.type === "edited") {
      const changes = detail.changes || {};
      const parts = Object.entries(changes).map(([key, value]) => {
        const fromVal = formatChangeValue(key, value.from);
        const toVal = formatChangeValue(key, value.to);
        return `${key.replace("_", " ")}: ${fromVal} → ${toVal}`;
      });
      const meta = parts.length > 0 ? `${parts.join(" · ")} · ${time}` : time;
      return { title: "Edited bill", meta };
    }
    return { title: "Updated", meta: time };
  };

  events.forEach((event) => {
    const row = document.createElement("div");
    row.className = "list-row";
    const left = document.createElement("div");
    left.className = "list-main";
    const title = document.createElement("div");
    title.className = "item-title";
    const meta = document.createElement("div");
    meta.className = "item-sub";
    const desc = describeEvent(event);
    title.textContent = desc.title;
    meta.textContent = desc.meta;
    left.appendChild(title);
    left.appendChild(meta);
    row.appendChild(left);
    els.detailHistory.appendChild(row);
  });
}

function isSplitView() {
  return window.matchMedia("(min-width: 1024px) and (orientation: landscape)").matches;
}

function getDetailPanel() {
  return document.querySelector("#details-drawer .drawer-panel, #details-pane .drawer-panel");
}

function renderDetailsEmpty() {
  if (els.detailsPaneEmpty) {
    els.detailsPaneEmpty.classList.remove("hidden");
  }
  const panel = getDetailPanel();
  if (panel) panel.classList.add("hidden");
}

function mountDetailPanelToPane() {
  if (!els.detailsPane) return;
  const panel = getDetailPanel();
  if (!panel) return;
  els.detailsPane.appendChild(panel);
  els.detailsPane.classList.remove("hidden");
  if (els.detailsDrawer) els.detailsDrawer.classList.add("hidden");
}

function mountDetailPanelToDrawer() {
  if (!els.detailsDrawer) return;
  const panel = getDetailPanel();
  if (!panel) return;
  els.detailsDrawer.appendChild(panel);
}

function updateSplitView(force = false) {
  const shouldSplit = state.view === "today" && isSplitView();
  if (!force && shouldSplit === state.splitView) return;
  state.splitView = shouldSplit;
  document.body.classList.toggle("split-view", shouldSplit);
  if (shouldSplit) {
    mountDetailPanelToPane();
    if (!state.selectedInstanceId) renderDetailsEmpty();
  } else {
    mountDetailPanelToDrawer();
    if (els.detailsPane) els.detailsPane.classList.add("hidden");
  }
}

function openInstanceDetail(instanceId) {
  const derived = deriveInstances();
  const item = derived.find((entry) => entry.id === instanceId);
  if (!item || !els.detailsDrawer) return;
  state.selectedInstanceId = instanceId;
  if (els.detailName) els.detailName.textContent = item.name_snapshot;
  if (els.detailMeta) {
    const statusLabel = formatStatusLabel(item.status_derived);
    els.detailMeta.textContent = `Due ${formatShortDate(item.due_date)} · ${statusLabel}`;
  }
  if (els.detailMarkDone) {
    const isDone = item.status_derived === "paid" || item.amount_remaining <= 0;
    els.detailMarkDone.textContent = isDone ? "Done" : "Mark done";
    els.detailMarkDone.disabled = isDone;
  }
  if (els.detailSkip) {
    els.detailSkip.textContent = item.status_derived === "skipped" ? "Unskip" : "Mark skipped";
  }
  if (els.detailLogSubmit) {
    els.detailLogSubmit.disabled = item.status_derived === "skipped";
  }
  if (els.detailEditName) els.detailEditName.value = item.name_snapshot || "";
  if (els.detailEditCategory) els.detailEditCategory.value = item.category_snapshot || "";
  if (els.detailEditAmount) els.detailEditAmount.value = Number(item.amount || 0).toFixed(2);
  if (els.detailEditDue) els.detailEditDue.value = item.due_date || "";
  if (els.detailEditNote) els.detailEditNote.value = item.note || "";
  if (els.detailLogAmount) els.detailLogAmount.value = "";
  if (els.detailLogStatus) els.detailLogStatus.textContent = "";
  if (els.detailSaveStatus) els.detailSaveStatus.textContent = "";
  renderDetailHistory(instanceId);
  if (state.splitView) {
    if (els.detailsPaneEmpty) els.detailsPaneEmpty.classList.add("hidden");
    const panel = getDetailPanel();
    if (panel) panel.classList.remove("hidden");
    mountDetailPanelToPane();
  } else {
    els.detailsDrawer.classList.remove("hidden");
  }
}

function closeInstanceDetail() {
  if (state.splitView) {
    state.selectedInstanceId = null;
    renderDetailsEmpty();
    return;
  }
  if (els.detailsDrawer) els.detailsDrawer.classList.add("hidden");
  state.selectedInstanceId = null;
}

function renderMonthReview(baseList) {
  if (!els.reviewList || !els.reviewSummary) return;
  els.reviewList.innerHTML = "";
  els.reviewSummary.innerHTML = "";

  const summary = computeTotals(baseList);
  const activeItems = baseList.filter((item) => item.status_derived !== "skipped");
  const paidItems = activeItems.filter((item) => item.amount_remaining <= 0);

  const payments = state.payments || [];
  if (activeItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "No items this month.";
    els.reviewList.appendChild(empty);
  }

  const nameMap = new Map(state.instances.map((inst) => [inst.id, inst.name_snapshot]));
  let firstPayment = null;
  let lastPayment = null;
  const lastPaidMap = new Map();
  payments.forEach((payment) => {
    if (!firstPayment || payment.paid_date < firstPayment.paid_date) {
      firstPayment = payment;
    }
    if (!lastPayment || payment.paid_date > lastPayment.paid_date) {
      lastPayment = payment;
    }
    const current = lastPaidMap.get(payment.instance_id);
    if (!current || payment.paid_date > current) {
      lastPaidMap.set(payment.instance_id, payment.paid_date);
    }
  });

  let onTimeCount = 0;
  let paidCount = 0;
  let daySum = 0;
  let worstLate = null;
  let bestEarly = null;
  paidItems.forEach((item) => {
    const lastPaid = lastPaidMap.get(item.id) || item.paid_date;
    if (!lastPaid) return;
    paidCount += 1;
    if (lastPaid <= item.due_date) onTimeCount += 1;
    const delta = diffDays(lastPaid, item.due_date);
    daySum += delta;
    if (delta > 0 && (!worstLate || delta > worstLate.days)) {
      worstLate = { id: item.id, days: delta };
    }
    if (delta <= 0 && (!bestEarly || delta < bestEarly.days)) {
      bestEarly = { id: item.id, days: delta };
    }
  });
  const onTimeRate = paidCount > 0 ? Math.round((onTimeCount / paidCount) * 100) : 0;
  const avgDays = paidCount > 0 ? (daySum / paidCount).toFixed(1) : "0.0";

  const remainingMetric = document.createElement("div");
  remainingMetric.className = "review-metric";
  const remainingLabel = document.createElement("div");
  remainingLabel.className = "review-label";
  remainingLabel.textContent = "Remaining total";
  const remainingValue = document.createElement("div");
  remainingValue.className = "review-value";
  remainingValue.textContent = formatMoney(summary.remaining);
  const remainingSub = document.createElement("div");
  remainingSub.className = "review-sub";
  remainingSub.textContent = "Reference amount";
  remainingMetric.appendChild(remainingLabel);
  remainingMetric.appendChild(remainingValue);
  remainingMetric.appendChild(remainingSub);

  const doneMetric = document.createElement("div");
  doneMetric.className = "review-metric";
  const doneLabel = document.createElement("div");
  doneLabel.className = "review-label";
  doneLabel.textContent = "Items done";
  const doneValue = document.createElement("div");
  doneValue.className = "review-value";
  doneValue.textContent = `${paidItems.length}/${activeItems.length}`;
  const doneSub = document.createElement("div");
  doneSub.className = "review-sub";
  doneSub.textContent = `${formatMoney(summary.paid)} of ${formatMoney(summary.required)}`;
  doneMetric.appendChild(doneLabel);
  doneMetric.appendChild(doneValue);
  doneMetric.appendChild(doneSub);

  const timeMetric = document.createElement("div");
  timeMetric.className = "review-metric";
  const timeLabel = document.createElement("div");
  timeLabel.className = "review-label";
  timeLabel.textContent = "On‑time Rate";
  const timeValue = document.createElement("div");
  timeValue.className = "review-value";
  timeValue.textContent = paidCount > 0 ? `${onTimeRate}%` : "—";
  const timeSub = document.createElement("div");
  timeSub.className = "review-sub";
  timeSub.textContent = paidCount > 0 ? `Avg ${avgDays} days vs due` : "No paid bills";
  timeMetric.appendChild(timeLabel);
  timeMetric.appendChild(timeValue);
  timeMetric.appendChild(timeSub);

  els.reviewSummary.appendChild(remainingMetric);
  els.reviewSummary.appendChild(doneMetric);
  els.reviewSummary.appendChild(timeMetric);

  const addRow = (title, body) => {
    const row = document.createElement("div");
    row.className = "list-item";
    const left = document.createElement("div");
    const t = document.createElement("div");
    t.className = "title";
    t.textContent = title;
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = body;
    left.appendChild(t);
    left.appendChild(m);
    row.appendChild(left);
    els.reviewList.appendChild(row);
  };

  addRow("Updates logged", `${payments.length} update(s)`);

  if (firstPayment) {
    const name = nameMap.get(firstPayment.instance_id) || "Update";
    addRow(
      "First update",
      `${name} on ${formatShortDate(firstPayment.paid_date)} (${formatMoney(firstPayment.amount)})`
    );
  }
  if (lastPayment) {
    const name = nameMap.get(lastPayment.instance_id) || "Update";
    addRow(
      "Last update",
      `${name} on ${formatShortDate(lastPayment.paid_date)} (${formatMoney(lastPayment.amount)})`
    );
  }

  if (worstLate) {
    const name = nameMap.get(worstLate.id) || "Bill";
    addRow("Most late", `${name} by ${worstLate.days} day(s)`);
  } else if (bestEarly) {
    const name = nameMap.get(bestEarly.id) || "Bill";
    addRow("Best early", `${name} by ${Math.abs(bestEarly.days)} day(s)`);
  }

  if (!firstPayment && payments.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "No updates logged yet.";
    els.reviewList.appendChild(empty);
  }
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
        essential: essentialInput.checked,
        active: activeInput.checked,
        default_note: noteInput.value.trim(),
        match_payee_key: matchKeyInput.value.trim(),
        match_amount_tolerance: Number(matchToleranceInput.value || 0),
      };

      const res = await fetch(
        `/api/templates/${template.id}?year=${state.selectedYear}&month=${state.selectedMonth}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      if (!res.ok) {
        let message = "Unable to save template.";
        try {
          const data = await res.json();
          message = getErrorMessage(data, message);
        } catch (err) {
          // ignore
        }
        window.alert(message);
        return;
      }

      await refreshAll();
    });

    archiveBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      await fetch(`/api/templates/${template.id}/archive`, { method: "POST" });
      await refreshAll();
    });

    deleteBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      const confirmed = window.confirm("Delete this template? This cannot be undone.");
      if (!confirmed) return;
      await fetch(
        `/api/templates/${template.id}?year=${state.selectedYear}&month=${state.selectedMonth}`,
        { method: "DELETE" }
      );
      await refreshAll();
    });

    row.appendChild(selectWrap);
    row.appendChild(activeToggle);
    row.appendChild(essentialToggle);
    row.appendChild(nameInput);
    row.appendChild(categoryInput);
    row.appendChild(amountInput);
    row.appendChild(dueInput);
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
    const res = await fetch(
      `/api/templates/${id}?year=${state.selectedYear}&month=${state.selectedMonth}`,
      {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      }
    );
    if (!res.ok) {
      let message = "Unable to save template.";
      try {
        const data = await res.json();
        message = getErrorMessage(data, message);
      } catch (err) {
        // ignore
      }
      window.alert(message);
      throw new Error(message);
    }
  }
  await refreshAll();
  return dirtyEntries.length;
}

function renderFundsList() {
  if (!els.fundsList) return;
  els.fundsList.innerHTML = "";
  if (!state.funds || state.funds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "meta";
    empty.textContent = "Add a reserved bucket to get started.";
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
      const confirmed = window.confirm("Archive this reserved bucket?");
      if (!confirmed) return;
      await postAction({ type: "ARCHIVE_FUND", fund_id: fund.id });
      await refreshAll();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn-small";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      const confirmed = window.confirm("Delete this reserved bucket? This cannot be undone.");
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
  renderSummary(base);
  renderZeroState();
  renderStatusBar(base);
  renderActionQueue(base);
  renderRecentStrip();
  renderCategoryFilter(base);
  renderItems(base);
  renderActivity();
  renderMonthReview(base);
}

function renderView() {
  const isToday = state.view === "today";
  const isReview = state.view === "review";
  const isSetup = state.view === "setup";

  if (els.todayView) els.todayView.classList.toggle("hidden", !isToday);
  if (els.reviewView) els.reviewView.classList.toggle("hidden", !isReview);
  if (els.setupView) els.setupView.classList.toggle("hidden", !isSetup);

  if (els.navToday) els.navToday.classList.toggle("active", isToday);
  if (els.navReview) els.navReview.classList.toggle("active", isReview);
  if (els.navSetup) els.navSetup.classList.toggle("active", isSetup);

  updateSplitView(true);
  if (!isToday && els.detailsDrawer) {
    els.detailsDrawer.classList.add("hidden");
  }
  if (!isToday && els.detailsPane) {
    els.detailsPane.classList.add("hidden");
  }
}

async function refreshAll() {
  state.loading = true;
  renderDashboard();
  try {
    syncToCurrentMonth();
    await ensureMonth();
    await Promise.all([
      loadSettings(),
      loadTemplates(),
      loadInstances(),
      loadPayments(),
      loadActivityEvents(),
      loadFunds(),
      loadQwenAuthStatus(),
      loadCommandLog(),
      loadChatHistory(),
    ]);
    renderDefaults();
    renderCategories();
    renderDashboard();
    renderTemplates();
  } catch (err) {
    if (!handleStorageFailure(err)) {
      throw err;
    }
  } finally {
    state.loading = false;
  }
}

function bindEvents() {
  els.prevMonth.addEventListener("click", () => {
    let year = state.selectedYear;
    let month = state.selectedMonth - 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
    setMonthWithLock(year, month, true);
    refreshAll();
  });

  els.nextMonth.addEventListener("click", () => {
    let year = state.selectedYear;
    let month = state.selectedMonth + 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    setMonthWithLock(year, month, true);
    refreshAll();
  });

  els.monthPicker.addEventListener("change", () => {
    const { year, month } = parseMonthInput(els.monthPicker.value);
    if (year && month) {
      setMonthWithLock(year, month, true);
      refreshAll();
    }
  });

  els.essentialsToggle.addEventListener("change", () => {
    state.essentialsOnly = els.essentialsToggle.checked;
    renderDashboard();
  });

  if (els.navToday) {
    els.navToday.addEventListener("click", () => {
      state.view = "today";
      renderView();
    });
  }

  if (els.navReview) {
    els.navReview.addEventListener("click", () => {
      state.view = "review";
      renderView();
    });
  }

  if (els.navSetup) {
    els.navSetup.addEventListener("click", () => {
      state.view = "setup";
      renderView();
    });
  }

  els.backupOpen.addEventListener("click", () => {
    els.backupModal.classList.remove("hidden");
  });

  els.backupClose.addEventListener("click", () => {
    els.backupModal.classList.add("hidden");
  });

  if (els.statusExpand && els.summarySheet) {
    els.statusExpand.addEventListener("click", () => {
      els.summarySheet.classList.remove("hidden");
    });
  }
  if (els.summaryClose && els.summarySheet) {
    els.summaryClose.addEventListener("click", () => {
      els.summarySheet.classList.add("hidden");
    });
  }
  if (els.summarySheet) {
    els.summarySheet.addEventListener("click", (event) => {
      if (event.target === els.summarySheet) {
        els.summarySheet.classList.add("hidden");
      }
    });
  }

  if (els.markAllOverdue) {
    els.markAllOverdue.addEventListener("click", async () => {
      const derived = deriveInstances();
      const base = getBaseInstances(derived);
      const today = getTodayDateString();
      const currentMonth = isCurrentMonth(state.selectedYear, state.selectedMonth);
      const overdue = base.filter(
        (item) =>
          item.status_derived !== "skipped" &&
          item.amount_remaining > 0 &&
          currentMonth &&
          item.due_date < today
      );
      if (overdue.length === 0) {
        window.alert("No overdue items.");
        return;
      }
      const preview = overdue.slice(0, 5).map((item) => item.name_snapshot).join(", ");
      const suffix = overdue.length > 5 ? "…" : "";
      const confirmed = window.confirm(`Mark ${overdue.length} overdue item(s) done?\n${preview}${suffix}`);
      if (!confirmed) return;
      const ids = overdue.map((item) => item.id);
      for (const item of overdue) {
        await markPaid(item.id, { silent: true });
      }
      showToast(`Marked ${overdue.length} overdue item(s) done.`, "Undo", async () => {
        for (const id of ids) {
          await markPending(id);
        }
      });
    });
  }

  if (els.toggleLater) {
    els.toggleLater.addEventListener("click", () => {
      state.queueLaterCollapsed = !state.queueLaterCollapsed;
      renderActionQueue(getBaseInstances(deriveInstances()));
    });
  }

  if (els.recentStrip) {
    els.recentStrip.addEventListener("click", () => {
      state.view = "review";
      renderView();
    });
  }

  if (els.openPiggyManage) {
    els.openPiggyManage.addEventListener("click", () => {
      state.view = "setup";
      renderView();
      document.getElementById("funds-section")?.scrollIntoView({ behavior: "smooth" });
    });
  }

  if (els.piggyCta) {
    els.piggyCta.addEventListener("click", () => {
      state.view = "setup";
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
    if (AJL_WEB_MODE) {
      fetch(url)
        .then((res) => res.text())
        .then((csv) => {
          const blob = new Blob([csv], { type: "text/csv" });
          const blobUrl = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = blobUrl;
          link.download = `au_jour_le_jour_${state.selectedYear}-${pad2(state.selectedMonth)}.csv`;
          link.click();
          URL.revokeObjectURL(blobUrl);
        })
        .catch(() => {
          window.alert("Unable to export CSV.");
        });
      return;
    }
    window.open(url, "_blank");
  });

  els.exportBackup.addEventListener("click", async () => {
    const res = await fetch("/api/export/backup.json");
    const data = await readApiData(res);
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

  if (els.saveDefaults) {
    els.saveDefaults.addEventListener("click", async () => {
      const dueSoonValue = Number(els.defaultsDueSoon?.value || 7);
      state.settings.defaults = {
        sort: els.defaultsSort?.value || "due_date",
        dueSoonDays: Number.isFinite(dueSoonValue) ? Math.max(1, dueSoonValue) : 7,
        defaultPeriod: els.defaultsPeriod?.value || "month",
      };
      await saveSettings({ defaults: state.settings.defaults });
      renderDefaults();
      renderDashboard();
    });
  }

  if (els.categoryAdd) {
    els.categoryAdd.addEventListener("click", () => addCategory());
  }

  if (els.categoryInput) {
    els.categoryInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addCategory();
      }
    });
  }

  if (els.resetLocal) {
    els.resetLocal.addEventListener("click", async () => {
      const confirmed = window.confirm("Reset all local data in this browser? This cannot be undone.");
      if (!confirmed) return;
      await fetch("/api/reset-local", { method: "POST" });
      window.location.reload();
    });
  }

  if (els.resetLocalInline) {
    els.resetLocalInline.addEventListener("click", async () => {
      const confirmed = window.confirm("Reset all local data in this browser? This cannot be undone.");
      if (!confirmed) return;
      await fetch("/api/reset-local", { method: "POST" });
      window.location.reload();
    });
  }

  if (els.startSafeMode) {
    els.startSafeMode.addEventListener("click", () => {
      const url = new URL(window.location.href);
      url.searchParams.set("safe", "1");
      window.location.href = url.toString();
    });
  }

  if (els.searchInput) {
    els.searchInput.addEventListener("input", () => {
      state.filters.search = els.searchInput.value.trim();
      renderDashboard();
    });
  }

  if (els.statusChips) {
    els.statusChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const status = chip.dataset.status || "all";
        state.filters.status = status;
        els.statusChips.forEach((btn) => btn.classList.remove("active"));
        chip.classList.add("active");
        renderDashboard();
      });
    });
  }

  if (els.filterOpen) {
    els.filterOpen.addEventListener("click", () => openFilterSheet());
  }
  if (els.filterClose) {
    els.filterClose.addEventListener("click", () => closeFilterSheet());
  }
  if (els.filterSheet) {
    els.filterSheet.addEventListener("click", (event) => {
      if (event.target === els.filterSheet) closeFilterSheet();
    });
  }
  if (els.filterStatusChips) {
    els.filterStatusChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const status = chip.dataset.status || "all";
        state.filters.status = status;
        if (els.statusChips) {
          els.statusChips.forEach((btn) => btn.classList.remove("active"));
          const match = els.statusChips.find((btn) => btn.dataset.status === status);
          if (match) match.classList.add("active");
        }
        syncFilterSheet();
      });
    });
  }
  if (els.filterApply) {
    els.filterApply.addEventListener("click", () => {
      if (els.filterCategory) state.filters.category = els.filterCategory.value;
      if (els.filterSort) state.filters.sort = els.filterSort.value;
      if (els.categoryFilter) els.categoryFilter.value = state.filters.category;
      if (els.sortFilter) els.sortFilter.value = state.filters.sort;
      closeFilterSheet();
      renderDashboard();
    });
  }

  if (els.reviewFilters) {
    els.reviewFilters.forEach((chip) => {
      chip.addEventListener("click", () => {
        const range = chip.dataset.reviewRange || "month";
        state.reviewRange = range;
        els.reviewFilters.forEach((btn) => btn.classList.remove("active"));
        chip.classList.add("active");
        renderActivity();
      });
    });
  }

  els.categoryFilter.addEventListener("change", () => {
    state.filters.category = els.categoryFilter.value;
    renderDashboard();
  });

  els.sortFilter.addEventListener("change", () => {
    state.filters.sort = els.sortFilter.value;
    renderDashboard();
  });

  if (els.detailsDrawer) {
    els.detailsDrawer.addEventListener("click", (event) => {
      const target = event.target;
      if (target && target.dataset && target.dataset.close === "details") {
        closeInstanceDetail();
      }
    });
  }
  if (els.detailsPane) {
    els.detailsPane.addEventListener("click", (event) => {
      const target = event.target;
      if (target && target.dataset && target.dataset.close === "details") {
        closeInstanceDetail();
      }
    });
  }

  if (els.detailMarkDone) {
    els.detailMarkDone.addEventListener("click", async () => {
      if (!state.selectedInstanceId) return;
      await markPaid(state.selectedInstanceId);
      renderDetailHistory(state.selectedInstanceId);
      openInstanceDetail(state.selectedInstanceId);
    });
  }

  if (els.detailSkip) {
    els.detailSkip.addEventListener("click", async () => {
      if (!state.selectedInstanceId) return;
      const derived = deriveInstances();
      const current = derived.find((item) => item.id === state.selectedInstanceId);
      const nextStatus = current?.status_derived === "skipped" ? "pending" : "skipped";
      await patchInstance(state.selectedInstanceId, { status: nextStatus });
      openInstanceDetail(state.selectedInstanceId);
    });
  }

  if (els.detailLogSubmit) {
    els.detailLogSubmit.addEventListener("click", async () => {
      if (!state.selectedInstanceId) return;
      const value = Number(els.detailLogAmount?.value || 0);
      if (!Number.isFinite(value) || value <= 0) {
        if (els.detailLogStatus) els.detailLogStatus.textContent = "Enter a valid amount.";
        return;
      }
      await addPayment(state.selectedInstanceId, value);
      if (els.detailLogAmount) els.detailLogAmount.value = "";
      if (els.detailLogStatus) els.detailLogStatus.textContent = "Update logged.";
      openInstanceDetail(state.selectedInstanceId);
    });
  }

  if (els.detailSave) {
    els.detailSave.addEventListener("click", async () => {
      if (!state.selectedInstanceId) return;
      const current = state.instances.find((inst) => inst.id === state.selectedInstanceId);
      const nameValue = String(els.detailEditName?.value || "").trim() || current?.name_snapshot || "";
      const categoryValue = String(els.detailEditCategory?.value || "").trim();
      const dueValue = els.detailEditDue?.value || current?.due_date || "";
      const payload = {
        name_snapshot: nameValue,
        category_snapshot: categoryValue || null,
        amount: Number(els.detailEditAmount?.value || 0),
        due_date: dueValue,
        note: els.detailEditNote?.value || "",
      };
      await patchInstance(state.selectedInstanceId, payload);
      if (els.detailSaveStatus) els.detailSaveStatus.textContent = "Saved.";
      openInstanceDetail(state.selectedInstanceId);
    });
  }

  if (els.assistantFab && els.assistantDrawer) {
    els.assistantFab.addEventListener("click", () => {
      els.assistantDrawer.classList.remove("hidden");
    });
  }

  if (els.assistantDrawer) {
    els.assistantDrawer.addEventListener("click", (event) => {
      const target = event.target;
      if (target && target.dataset && target.dataset.close === "assistant") {
        els.assistantDrawer.classList.add("hidden");
      }
    });
  }

  window.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== els.searchInput) {
      event.preventDefault();
      els.searchInput?.focus();
    }
  });

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
      essential: els.templateEssential.checked,
      active: els.templateActive.checked,
      default_note: els.templateNote.value.trim(),
      match_payee_key: els.templateMatchKey.value.trim(),
      match_amount_tolerance: Number(els.templateMatchTolerance.value || 0),
    };

    const res = await fetch(
      `/api/templates?year=${state.selectedYear}&month=${state.selectedMonth}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    if (res.ok) {
      els.templateForm.reset();
      els.templateEssential.checked = true;
      els.templateActive.checked = true;
      await refreshAll();
    } else if (els.templateError) {
      let message = "Unable to add bill.";
      try {
        const data = await res.json();
        message = getErrorMessage(data, message);
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
      "Apply template values to this month? This will overwrite names, amounts, due dates, and essential flags for the selected month."
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
      await refreshAll();
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
        await fetch(
          `/api/templates/${id}?year=${state.selectedYear}&month=${state.selectedMonth}`,
          { method: "DELETE" }
        );
      }
      state.selectedTemplates = new Set();
      await refreshAll();
    });
  }

  if (els.llmAgentSend) {
    els.llmAgentSend.addEventListener("click", () => {
      sendLlmAgent();
    });
  }

  if (els.llmAgentConfirm) {
    els.llmAgentConfirm.addEventListener("click", async () => {
      const pending = state.pendingAgentAction;
      if (!pending) return;
      els.llmAgentOutput.textContent = "Applying...";
      let outcome = { ok: false, message: "No action applied." };
      if (pending.kind === "command") {
        outcome = await applyProposal(pending.proposal);
      } else if (pending.kind === "intake") {
        outcome = await applyIntakeTemplates(pending.templates || []);
      }
      await logAgentCommand({
        user_text: pending.source_text || "",
        kind: pending.kind || "command",
        summary: pending.summary || "",
        status: outcome?.ok ? "ok" : "error",
        payload:
          pending.kind === "intake"
            ? { templates: pending.templates || [] }
            : { proposal: pending.proposal || null },
        result: outcome,
      });
      await loadCommandLog();
      els.llmAgentOutput.textContent = "";
      pushLlmMessage("assistant", outcome.message, pending.summary || "");
      clearPendingAgentAction();
      focusAgentInput();
    });
  }

  if (els.llmAgentCancel) {
    els.llmAgentCancel.addEventListener("click", () => {
      if (!state.pendingAgentAction) return;
      clearPendingAgentAction();
      els.llmAgentOutput.textContent = "";
      pushLlmMessage("assistant", "Canceled.");
      focusAgentInput();
    });
  }

  if (els.llmChatClear) {
    els.llmChatClear.addEventListener("click", async () => {
      const confirmed = window.confirm("Clear all Mamdou chat history?");
      if (!confirmed) return;
      await clearChatHistory();
    });
  }

  if (els.assistantToggle && els.assistantPanel) {
    els.assistantToggle.addEventListener("click", () => {
      const isCollapsed = els.assistantPanel.classList.toggle("collapsed");
      if (els.assistantCard) {
        els.assistantCard.classList.toggle("collapsed", isCollapsed);
      }
      els.assistantToggle.textContent = isCollapsed ? "Show Mamdou" : "Hide Mamdou";
      if (!isCollapsed) {
        focusAgentInput({ scroll: true });
      }
    });
  }

  if (els.llmAgentInput) {
    els.llmAgentInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendLlmAgent();
      }
    });
    els.llmAgentInput.addEventListener("focus", () => {
      els.assistantCard?.classList.add("active");
    });
    els.llmAgentInput.addEventListener("blur", () => {
      els.assistantCard?.classList.remove("active");
    });
  }

  if (els.assistantNameInput) {
    els.assistantNameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        els.assistantNameSave?.click();
      }
    });
  }

  if (els.assistantNameSave && els.assistantNameInput) {
    els.assistantNameSave.addEventListener("click", () => {
      const name = String(els.assistantNameInput.value || "").trim();
      state.profileName = name;
      saveProfileName(name);
      updateAssistantGreeting();
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
          els.fundError.textContent = getErrorMessage(res, "Unable to add fund.");
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
      state.view = "setup";
      renderView();
    });
  }
}

async function init() {
  const flags = getQueryFlags();
  const crashGuard = checkCrashGuard();
  if (await handleResetFlag()) return;
  const now = new Date();
  setMonth(now.getFullYear(), now.getMonth() + 1);
  state.monthLocked = false;
  state.lastAutoMonthKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  state.essentialsOnly = els.essentialsToggle.checked;
  state.profileName = loadProfileName();
  state.view = "today";
  if (flags.safe || crashGuard) {
    enterSafeMode(flags.safe ? "Safe mode requested." : "Repeated crashes detected.");
    state.view = "setup";
  }
  if (!AJL_WEB_MODE) {
    setupStorageRecovery();
  }
  bindEvents();
  renderView();
  if (els.fundMonths && els.fundCadence && els.fundCadence.value !== "custom_months") {
    els.fundMonths.disabled = true;
  }
  updateSplitView(true);
  window.addEventListener("resize", () => {
    if (splitViewTimer) clearTimeout(splitViewTimer);
    splitViewTimer = setTimeout(() => updateSplitView(), 150);
  });
  window.addEventListener("orientationchange", () => updateSplitView(true));
  if (!state.safeMode) {
    refreshAll();
    refreshTimer = setInterval(() => {
      if (!document.hidden) refreshAll();
    }, 60000);
    window.addEventListener("focus", () => refreshAll());
  }

  if (els.assistantPanel && !els.assistantPanel.classList.contains("collapsed")) {
    setTimeout(() => focusAgentInput(), 200);
  }
}

init();
