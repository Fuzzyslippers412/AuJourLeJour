const state = {
  templates: [],
  instances: [],
  payments: [],
  funds: [],
  selectedTemplates: new Set(),
  settings: {
    defaults: { sort: "due_date", dueSoonDays: 7, defaultPeriod: "month" },
    categories: [],
    share_base_url: "",
    share_viewer_base_url: "",
  },
  nudges: [],
  lastNudgeKey: null,
  lastNudgeAt: 0,
  nudgeInFlight: false,
  llmStatus: { status: "unknown", auth_url: null, error: null },
  llmProviders: null,
  llmChecked: false,
  qwenAuth: { connected: false, status: "unknown", session_id: null, verification_uri_complete: null, interval_seconds: null },
  llmHistory: [],
  commandLog: [],
  profileName: "",
  webMeta: null,
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
    preset: "none",
  },
  reviewRange: "month",
  selectedInstanceId: null,
  splitView: false,
  loading: false,
  instanceEvents: {},
  activityEvents: [],
  pendingImport: null,
  lastBackupAt: null,
  readOnly: false,
  summaryExpanded: false,
  shareToken: null,
  shareInfo: null,
  shareBusy: false,
  shareOwnerLabel: "",
  shareOwnerKey: "",
  shareExpiryPreset: "never",
  sharePrivacy: null,
  sharedMeta: null,
  sharedEtag: "",
  shareOptions: {
    includeAmounts: true,
    includeNotes: true,
    includeCategories: true,
  },
  shareRelayBackoffUntil: 0,
  lanInfo: null,
  integrityStatus: "unknown",
  dataVersion: 0,
  summaryCache: null,
  janitorReport: null,
  janitorSelectedId: "",
  janitorFilter: {
    status: "all",
    severity: "all",
    suite: "all",
    search: "",
  },
  janitorRuntimeBase: "",
  janitorRuntimeRequired: false,
  agentBusy: false,
  lastAgentInput: "",
  lastAgentSubmittedAt: 0,
};

const weeksPerMonth = 4.33;
const daysPerMonthAvg = 30.4;
let flashTimer = null;
let autoMonthTimer = null;
let refreshTimer = null;
let splitViewTimer = null;
let sharedLiveTimer = null;
let sharePublishTimer = null;
let sharePublishRetryTimer = null;
let sharePublishInFlight = false;
let sharePublishRetryCount = 0;
let sharePublishDirty = false;
let diagnosticsInFlight = false;
let lastDiagnosticsAt = 0;
let shannonInFlight = false;
let shannonPollTimer = null;
let shannonLastRunId = "";
let shannonLastRunning = false;
let janitorReportInFlight = false;
let scrollShadowBound = false;
let storageFailureHandled = false;
const MAX_LLM_INSTANCES = 20;
const MAX_LLM_TEMPLATES = 20;
const MAX_LLM_FUNDS = 10;
const MAX_LLM_DUE = 6;
const NUDGE_CACHE_TTL_MS = 45_000;
const AGENT_DUPLICATE_WINDOW_MS = 1200;
const AJL_WEB_MODE = !!window.AJL_WEB_MODE;
const DEFAULT_SHARE_BASE_URL = AJL_WEB_MODE ? "https://agent.aujourlejour.xyz" : "";
const SHARE_BASE_URL_CONFIG = String(window.AJL_SHARE_BASE_URL || DEFAULT_SHARE_BASE_URL)
  .trim()
  .replace(/\/+$/, "");
const PROFILE_NAME_KEY = "ajl_profile_name";
const BACKUP_LAST_KEY = "ajl_last_backup_at";
const LOCAL_EDIT_COUNT_KEY = "ajl_local_edit_count";
const LOCAL_BACKUP_REMINDER_KEY = "ajl_local_backup_reminder";
const SHARE_OWNER_KEY = "ajl_share_owner_key";
const SHARE_OPTIONS_KEY = "ajl_share_options";
const SHARE_LIVE_REFRESH_MS = 8000;
const SHARE_RELAY_TIMEOUT_MS = 4500;
const SHARE_PUBLISH_BASE_DELAY_MS = 1500;
const SHARE_PUBLISH_MAX_DELAY_MS = 60000;
const PWA_DB_NAME = "ajl_pwa";
const PWA_DB_PREFIX = "ajl_pwa";
const WEB_META_KEY = "auj_web_meta";
const BACKUP_REMINDER_THRESHOLD = 25;
const STORAGE_HEALTH_WARNING_BYTES = 4_000_000;
const JANITOR_RUNTIME_BASE_KEY = "ajl_janitor_runtime_base";
const JANITOR_RUNTIME_REQUIRED_KEY = "ajl_janitor_runtime_required";

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

function getRequestIdFromResponse(res) {
  try {
    const id = res?.headers?.get("x-request-id");
    return id ? String(id) : "";
  } catch (err) {
    return "";
  }
}

async function apiFetch(url, options = {}, opts = {}) {
  const res = await fetch(url, options);
  if (!res.ok && !opts.silent) {
    let message = `Request failed (${res.status}).`;
    const requestId = getRequestIdFromResponse(res);
    try {
      const data = await res.clone().json();
      message = getErrorMessage(data, message);
    } catch (err) {
      // ignore
    }
    if (requestId) {
      message = `${message} (ref: ${requestId})`;
    }
    showSystemBanner(message);
  }
  return res;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = SHARE_RELAY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(800, Number(timeoutMs) || SHARE_RELAY_TIMEOUT_MS));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
  navJanitor: document.getElementById("nav-janitor"),
  shareOpen: document.getElementById("share-open"),
  shareModal: document.getElementById("share-modal"),
  shareClose: document.getElementById("share-close"),
  shareLink: document.getElementById("share-link"),
  shareCopy: document.getElementById("share-copy"),
  shareLive: document.getElementById("share-live"),
  shareExpiry: document.getElementById("share-expiry"),
  shareExpiryCustomWrap: document.getElementById("share-expiry-custom-wrap"),
  shareExpiryCustom: document.getElementById("share-expiry-custom"),
  shareOwnerLabel: document.getElementById("share-owner-label"),
  shareIncludeAmounts: document.getElementById("share-include-amounts"),
  shareIncludeNotes: document.getElementById("share-include-notes"),
  shareIncludeCategories: document.getElementById("share-include-categories"),
  shareCreate: document.getElementById("share-create"),
  shareRefresh: document.getElementById("share-refresh"),
  shareRegenerate: document.getElementById("share-regenerate"),
  shareDisable: document.getElementById("share-disable"),
  shareRelayStatus: document.getElementById("share-relay-status"),
  backupOpen: document.getElementById("open-backup"),
  backupSection: document.getElementById("backup-section"),
  backupLast: document.getElementById("backup-last"),
  backupDrop: document.getElementById("backup-drop"),
  importPick: document.getElementById("import-pick"),
  importPreview: document.getElementById("import-preview"),
  importSummary: document.getElementById("import-summary"),
  importConflicts: document.getElementById("import-conflicts"),
  importConfirm: document.getElementById("import-confirm"),
  importModeChips: Array.from(document.querySelectorAll("#import-mode .chip")),
  exportMonth: document.getElementById("export-month"),
  exportSqlite: document.getElementById("export-sqlite"),
  exportBackup: document.getElementById("export-backup"),
  importBackup: document.getElementById("import-backup"),
  resetLocalInline: document.getElementById("reset-local-inline"),
  clearFilters: document.getElementById("clear-filters"),
  storageHealth: document.getElementById("storage-health"),
  lanUrl: document.getElementById("lan-url"),
  lanCopy: document.getElementById("lan-copy"),
  setupAgentStatus: document.getElementById("setup-agent-status"),
  setupAgentProvider: document.getElementById("setup-agent-provider"),
  setupAgentModel: document.getElementById("setup-agent-model"),
  setupAgentKeyRow: document.getElementById("setup-agent-key-row"),
  setupAgentKey: document.getElementById("setup-agent-key"),
  setupAgentBaseRow: document.getElementById("setup-agent-base-row"),
  setupAgentBase: document.getElementById("setup-agent-base"),
  setupAgentStart: document.getElementById("setup-agent-start"),
  setupAgentOpen: document.getElementById("setup-agent-open"),
  setupAgentSaveProvider: document.getElementById("setup-agent-save-provider"),
  setupAgentConnectKey: document.getElementById("setup-agent-connect-key"),
  setupAgentTest: document.getElementById("setup-agent-test"),
  setupAgentRefresh: document.getElementById("setup-agent-refresh"),
  setupAgentDisconnect: document.getElementById("setup-agent-disconnect"),
  diagnosticsRun: document.getElementById("diagnostics-run"),
  diagnosticsClearCache: document.getElementById("diagnostics-clear-cache"),
  diagnosticsCopy: document.getElementById("diagnostics-copy"),
  diagnosticsOutput: document.getElementById("diagnostics-output"),
  shannonRun: document.getElementById("shannon-run"),
  shannonRunLlmRuntime: document.getElementById("shannon-run-llm-runtime"),
  shannonRefresh: document.getElementById("shannon-refresh"),
  shannonCopy: document.getElementById("shannon-copy"),
  shannonStatus: document.getElementById("shannon-status"),
  shannonSummary: document.getElementById("shannon-summary"),
  shannonOutput: document.getElementById("shannon-output"),
  janitorRuntimeBase: document.getElementById("janitor-runtime-base"),
  janitorRuntimeRequired: document.getElementById("janitor-runtime-required"),
  janitorVerdict: document.getElementById("janitor-verdict"),
  janitorSuiteSummary: document.getElementById("janitor-suite-summary"),
  janitorSearch: document.getElementById("janitor-search"),
  janitorFilterStatus: document.getElementById("janitor-filter-status"),
  janitorFilterSeverity: document.getElementById("janitor-filter-severity"),
  janitorFilterSuite: document.getElementById("janitor-filter-suite"),
  janitorFindingsCount: document.getElementById("janitor-findings-count"),
  janitorFindingsList: document.getElementById("janitor-findings-list"),
  janitorDetailContent: document.getElementById("janitor-detail-content"),
  janitorCopyRepro: document.getElementById("janitor-copy-repro"),
  previewReadonly: document.getElementById("preview-readonly"),
  setupCta: document.getElementById("setup-cta"),
  ctaImport: document.getElementById("cta-import"),
  ctaTemplate: document.getElementById("cta-template"),
  firstVisitHero: document.getElementById("first-visit-hero"),
  firstVisitImport: document.getElementById("first-visit-import"),
  firstVisitTemplate: document.getElementById("first-visit-template"),
  firstVisitContinue: document.getElementById("first-visit-continue"),
  firstVisitWebNote: document.getElementById("first-visit-web-note"),
  wizardModal: document.getElementById("first-run-modal"),
  wizardImport: document.getElementById("wizard-import"),
  wizardTemplate: document.getElementById("wizard-template"),
  wizardSkip: document.getElementById("wizard-skip"),
  wizardFile: document.getElementById("wizard-file"),
  todayView: document.getElementById("today-view"),
  reviewView: document.getElementById("review-view"),
  setupView: document.getElementById("setup-view"),
  janitorView: document.getElementById("janitor-view"),
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
  miniRemainingAmount: document.getElementById("mini-remaining-amount"),
  miniDoneAmount: document.getElementById("mini-done-amount"),
  countRemaining: document.getElementById("count-remaining"),
  countOverdue: document.getElementById("count-overdue"),
  countSoon: document.getElementById("count-soon"),
  summaryPanel: document.getElementById("summary-panel"),
  summaryCountRemaining: document.getElementById("summary-count-remaining"),
  summaryCountOverdue: document.getElementById("summary-count-overdue"),
  summaryCountSoon: document.getElementById("summary-count-soon"),
  summaryCountDone: document.getElementById("summary-count-done"),
  sharedHeader: document.getElementById("shared-header"),
  sharedOwner: document.getElementById("shared-owner"),
  sharedUpdated: document.getElementById("shared-updated"),
  queueOverdue: document.getElementById("queue-overdue"),
  queueSoon: document.getElementById("queue-soon"),
  queueLater: document.getElementById("queue-later"),
  toggleLater: document.getElementById("toggle-later"),
  queueSubtitle: document.getElementById("queue-subtitle"),
  markAllOverdue: document.getElementById("mark-all-overdue"),
  markAllSoon: document.getElementById("mark-all-soon"),
  recentStrip: document.getElementById("recent-strip"),
  itemsList: document.getElementById("items-list"),
  searchInput: document.getElementById("search-input"),
  presetChips: Array.from(document.querySelectorAll("#preset-chips .chip")),
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
  reviewExport: document.getElementById("review-export"),
  reviewFilters: Array.from(document.querySelectorAll("[data-review-range]")),
  defaultsPeriod: document.getElementById("defaults-period"),
  defaultsSort: document.getElementById("defaults-sort"),
  defaultsDueSoon: document.getElementById("defaults-due-soon"),
  saveDefaults: document.getElementById("save-defaults"),
  categoryInput: document.getElementById("category-input"),
  categoryAdd: document.getElementById("category-add"),
  categoriesList: document.getElementById("categories-list"),
  startSafeMode: document.getElementById("start-safe-mode"),
  integrityStatus: document.getElementById("integrity-status"),
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
  assistantProviderSelect: document.getElementById("assistant-provider-select"),
  assistantProviderConnect: document.getElementById("assistant-provider-connect"),
  assistantProviderSetup: document.getElementById("assistant-provider-setup"),
  assistantProviderKeyRow: document.getElementById("assistant-provider-key-row"),
  assistantProviderKey: document.getElementById("assistant-provider-key"),
  assistantProviderHint: document.getElementById("assistant-provider-hint"),
  agentInlineConnection: document.getElementById("agent-inline-connection"),
  agentInlineOpen: document.getElementById("agent-inline-open"),
  agentInlineInput: document.getElementById("agent-inline-input"),
  agentInlineSend: document.getElementById("agent-inline-send"),
  agentInlineStatus: document.getElementById("agent-inline-status"),
  agentInlineActions: document.getElementById("agent-inline-actions"),
  agentInlineConfirm: document.getElementById("agent-inline-confirm"),
  agentInlineCancel: document.getElementById("agent-inline-cancel"),
  agentInlineShortcuts: Array.from(document.querySelectorAll("[data-agent-shortcut]")),
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

function isSharedAmountsHidden() {
  return !!(state.readOnly && state.sharePrivacy && state.sharePrivacy.include_amounts === false);
}

function formatMoneyDisplay(value) {
  return isSharedAmountsHidden() ? "Hidden" : formatMoney(value);
}

function escapeCsv(value) {
  const raw = value == null ? "" : String(value);
  if (raw.includes(",") || raw.includes("\"") || raw.includes("\n")) {
    return `"${raw.replace(/\"/g, '""')}"`;
  }
  return raw;
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

function loadShareOwnerKey() {
  try {
    return localStorage.getItem(SHARE_OWNER_KEY) || "";
  } catch (err) {
    return "";
  }
}

function saveShareOwnerKey(key) {
  try {
    if (!key) localStorage.removeItem(SHARE_OWNER_KEY);
    else localStorage.setItem(SHARE_OWNER_KEY, key);
  } catch (err) {
    // ignore
  }
}

function loadShareOptions() {
  const defaults = {
    includeAmounts: true,
    includeNotes: true,
    includeCategories: true,
  };
  try {
    const raw = localStorage.getItem(SHARE_OPTIONS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      includeAmounts: parsed.includeAmounts !== false,
      includeNotes: parsed.includeNotes !== false,
      includeCategories: parsed.includeCategories !== false,
    };
  } catch (err) {
    return defaults;
  }
}

function saveShareOptions() {
  try {
    localStorage.setItem(
      SHARE_OPTIONS_KEY,
      JSON.stringify({
        includeAmounts: state.shareOptions.includeAmounts !== false,
        includeNotes: state.shareOptions.includeNotes !== false,
        includeCategories: state.shareOptions.includeCategories !== false,
      })
    );
  } catch (err) {
    // ignore
  }
}

function normalizeJanitorRuntimeBase(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return raw;
    return `${parsed.protocol}//${parsed.host}`;
  } catch (err) {
    return raw;
  }
}

function validateJanitorRuntimeBase(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: true, value: "" };
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, error: "Runtime base URL must use http or https." };
    }
    return { ok: true, value: `${parsed.protocol}//${parsed.host}` };
  } catch (err) {
    return { ok: false, error: "Runtime base URL must be a valid absolute URL." };
  }
}

function loadJanitorRuntimeBase() {
  try {
    const raw = localStorage.getItem(JANITOR_RUNTIME_BASE_KEY) || "";
    return normalizeJanitorRuntimeBase(raw);
  } catch (err) {
    return "";
  }
}

function loadJanitorRuntimeRequired() {
  try {
    const raw = localStorage.getItem(JANITOR_RUNTIME_REQUIRED_KEY);
    if (!raw) return false;
    const value = String(raw).trim().toLowerCase();
    return value === "1" || value === "true";
  } catch (err) {
    return false;
  }
}

function saveJanitorRuntimeSettings() {
  try {
    const base = normalizeJanitorRuntimeBase(state.janitorRuntimeBase);
    state.janitorRuntimeBase = base;
    if (!base) {
      localStorage.removeItem(JANITOR_RUNTIME_BASE_KEY);
    } else {
      localStorage.setItem(JANITOR_RUNTIME_BASE_KEY, base);
    }
    localStorage.setItem(
      JANITOR_RUNTIME_REQUIRED_KEY,
      state.janitorRuntimeRequired ? "1" : "0"
    );
  } catch (err) {
    // ignore
  }
}

function getShareBaseUrl() {
  const fromSettings = String(state.settings?.share_base_url || "").trim().replace(/\/+$/, "");
  if (fromSettings) return fromSettings;
  return SHARE_BASE_URL_CONFIG;
}

function getShareViewerBaseUrl() {
  const fromSettings = String(state.settings?.share_viewer_base_url || "").trim().replace(/\/+$/, "");
  if (fromSettings) return fromSettings;
  const host = String(window.location.hostname || "").toLowerCase();
  const localHost =
    host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
  if (!AJL_WEB_MODE && localHost && state.lanInfo && Array.isArray(state.lanInfo.urls) && state.lanInfo.urls[0]) {
    return String(state.lanInfo.urls[0]).replace(/\/+$/, "");
  }
  return window.location.origin.replace(/\/+$/, "");
}

function hostLooksLocal(urlString) {
  try {
    const parsed = new URL(urlString);
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
  } catch (err) {
    return false;
  }
}

function getShareNetworkMode() {
  const shareBase = getShareBaseUrl();
  const viewerBase = getShareViewerBaseUrl();
  const viewerLocal = hostLooksLocal(viewerBase);
  if (shareBase) {
    return {
      mode: "relay",
      tone: "ok",
      message: `Share mode: Relay (${shareBase.replace(/^https?:\/\//i, "")})`,
      warning: viewerLocal ? "Viewer base resolves to localhost; other devices cannot open the link." : "",
    };
  }
  return {
    mode: "lan",
    tone: viewerLocal ? "warn" : "ok",
    message: viewerLocal ? "Share mode: Localhost only (same device)." : "Share mode: LAN direct.",
    warning: viewerLocal ? "Use LAN URL or set SHARE_VIEWER_BASE_URL for multi-device access." : "",
  };
}

async function ensureShareViewerBaseReady() {
  if (AJL_WEB_MODE) return;
  const host = String(window.location.hostname || "").toLowerCase();
  const localHost =
    host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
  if (!localHost) return;
  const urls = state.lanInfo && Array.isArray(state.lanInfo.urls) ? state.lanInfo.urls : [];
  if (urls.length > 0) return;
  await loadLanInfo();
}

function buildShareViewerUrl(token, fallbackUrl = "") {
  const cleanToken = String(token || "").trim();
  if (!cleanToken) return fallbackUrl || "";
  if (fallbackUrl && typeof fallbackUrl === "string") {
    if (/^https?:\/\//i.test(fallbackUrl)) {
      return fallbackUrl;
    }
    if (fallbackUrl.startsWith("/")) {
      return `${getShareViewerBaseUrl()}${fallbackUrl}`;
    }
  }
  const base = getShareViewerBaseUrl();
  return `${base}/?share=${encodeURIComponent(cleanToken)}`;
}

async function shareFetch(path, options = {}) {
  const base = getShareBaseUrl();
  const headers = new Headers(options.headers || {});
  const isPublicShareLookup = /^\/api\/shares\/[A-Za-z0-9_-]{12,}$/.test(path);
  const isOwnerPath = path === "/api/shares" || path.startsWith("/api/shares/");
  if (state.shareOwnerKey && !isPublicShareLookup) {
    headers.set("X-AJL-Share-Owner", state.shareOwnerKey);
  }
  const init = {
    ...options,
    headers,
  };
  const localInit = {
    ...init,
    credentials: "same-origin",
  };
  const remoteInit = {
    ...init,
    credentials: "omit",
  };
  if (!base) {
    return fetch(path, localInit);
  }
  if (!AJL_WEB_MODE && Date.now() < Number(state.shareRelayBackoffUntil || 0)) {
    return fetch(path, localInit);
  }
  try {
    const remoteRes = await fetchWithTimeout(`${base}${path}`, remoteInit, SHARE_RELAY_TIMEOUT_MS);
    if (
      remoteRes.status === 401 &&
      state.shareOwnerKey &&
      isOwnerPath &&
      !isPublicShareLookup
    ) {
      state.shareOwnerKey = "";
      saveShareOwnerKey("");
      updateShareStatusLine("Owner key expired. Create a new share link.", "warn");
    }
    if (
      !AJL_WEB_MODE &&
      [401, 404, 408, 429, 500, 502, 503, 504].includes(Number(remoteRes.status || 0))
    ) {
      state.shareRelayBackoffUntil = Date.now() + 15_000;
      updateShareStatusLine(
        `Share relay HTTP ${remoteRes.status}. Falling back to local service.`,
        "warn"
      );
      return fetch(path, localInit);
    }
    state.shareRelayBackoffUntil = 0;
    return remoteRes;
  } catch (err) {
    if (!AJL_WEB_MODE) {
      state.shareRelayBackoffUntil = Date.now() + 15_000;
      updateShareStatusLine("Share relay timeout. Falling back to local service.", "warn");
      return fetch(path, localInit);
    }
    throw new Error("Share relay unavailable. Try again in a few seconds.");
  }
}

async function readApiErrorMessage(res, fallbackMessage) {
  try {
    const payload = await res.clone().json();
    if (payload && typeof payload === "object") {
      if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
      if (payload.error && typeof payload.error.message === "string" && payload.error.message.trim()) {
        return payload.error.message;
      }
      if (typeof payload.message === "string" && payload.message.trim()) return payload.message;
    }
  } catch (err) {
    // fall through
  }
  return fallbackMessage;
}

function loadWebMeta() {
  try {
    const raw = localStorage.getItem(WEB_META_KEY);
    if (!raw) {
      return {
        schemaVersion: 1,
        firstRunCompleted: false,
        hasCompletedOnboarding: false,
        lastBackupAt: null,
        editCountSinceBackup: 0,
        readOnlyPreview: false,
        lastSeenAppVersion: null,
        lastBackupReminderAt: null,
      };
    }
    const parsed = JSON.parse(raw);
    return {
      schemaVersion: 1,
      firstRunCompleted: !!parsed.firstRunCompleted,
      hasCompletedOnboarding: !!(parsed.hasCompletedOnboarding ?? parsed.firstRunCompleted),
      lastBackupAt: parsed.lastBackupAt || null,
      editCountSinceBackup: Number(parsed.editCountSinceBackup || 0),
      readOnlyPreview: !!parsed.readOnlyPreview,
      lastSeenAppVersion: parsed.lastSeenAppVersion || null,
      lastBackupReminderAt: parsed.lastBackupReminderAt || null,
    };
  } catch (err) {
    return {
      schemaVersion: 1,
      firstRunCompleted: false,
      hasCompletedOnboarding: false,
      lastBackupAt: null,
      editCountSinceBackup: 0,
      readOnlyPreview: false,
      lastSeenAppVersion: null,
      lastBackupReminderAt: null,
    };
  }
}

function saveWebMeta(meta) {
  try {
    localStorage.setItem(WEB_META_KEY, JSON.stringify(meta));
  } catch (err) {
    // ignore
  }
}

function isFirstRunCompleted() {
  if (AJL_WEB_MODE) return !!state.webMeta?.hasCompletedOnboarding;
  return !!state.settings?.hasCompletedOnboarding;
}

async function setFirstRunCompleted(value) {
  return setOnboardingComplete(value);
}

async function setOnboardingComplete(value) {
  if (AJL_WEB_MODE) {
    if (!state.webMeta) state.webMeta = loadWebMeta();
    state.webMeta.firstRunCompleted = !!value;
    state.webMeta.hasCompletedOnboarding = !!value;
    saveWebMeta(state.webMeta);
    return;
  }
  state.settings.hasCompletedOnboarding = !!value;
  state.settings.firstRunCompleted = !!value;
  await saveSettings({
    hasCompletedOnboarding: state.settings.hasCompletedOnboarding,
    firstRunCompleted: state.settings.firstRunCompleted,
  });
}

function recordMutation() {
  if (AJL_WEB_MODE) {
    if (!state.webMeta) return;
    state.webMeta.editCountSinceBackup = (state.webMeta.editCountSinceBackup || 0) + 1;
    saveWebMeta(state.webMeta);
    maybeShowBackupReminder();
    return;
  }
  const current = loadLocalEditCount();
  saveLocalEditCount(current + 1);
  maybeShowBackupReminder();
}

function maybeShowBackupReminder() {
  const now = Date.now();
  if (AJL_WEB_MODE) {
    if (!state.webMeta) return;
    if (state.webMeta.editCountSinceBackup < BACKUP_REMINDER_THRESHOLD) return;
    const last = state.webMeta.lastBackupReminderAt || 0;
    if (now - last < 24 * 60 * 60 * 1000) return;
    state.webMeta.lastBackupReminderAt = now;
    saveWebMeta(state.webMeta);
  } else {
    const editCount = loadLocalEditCount();
    if (editCount < BACKUP_REMINDER_THRESHOLD) return;
    const last = loadLocalBackupReminder();
    if (now - last < 24 * 60 * 60 * 1000) return;
    saveLocalBackupReminder(now);
  }
  showToast("Tip: Export a backup.", "Export", () => {
    if (els.exportBackup) els.exportBackup.click();
  });
}

function loadLastBackupAt() {
  try {
    const raw = localStorage.getItem(BACKUP_LAST_KEY);
    return raw ? Number(raw) : null;
  } catch (err) {
    return null;
  }
}

function loadLocalEditCount() {
  try {
    const raw = localStorage.getItem(LOCAL_EDIT_COUNT_KEY);
    return raw ? Number(raw) : 0;
  } catch (err) {
    return 0;
  }
}

function saveLocalEditCount(value) {
  try {
    localStorage.setItem(LOCAL_EDIT_COUNT_KEY, String(value));
  } catch (err) {
    // ignore
  }
}

function loadLocalBackupReminder() {
  try {
    const raw = localStorage.getItem(LOCAL_BACKUP_REMINDER_KEY);
    return raw ? Number(raw) : 0;
  } catch (err) {
    return 0;
  }
}

function saveLocalBackupReminder(value) {
  try {
    localStorage.setItem(LOCAL_BACKUP_REMINDER_KEY, String(value));
  } catch (err) {
    // ignore
  }
}

function saveLastBackupAt(timestamp) {
  try {
    localStorage.setItem(BACKUP_LAST_KEY, String(timestamp));
  } catch (err) {
    // ignore
  }
}

function renderBackupStatus() {
  if (!els.backupLast) return;
  const ts = state.lastBackupAt;
  if (!ts) {
    els.backupLast.textContent = "Last backup: Never.";
    return;
  }
  const date = new Date(ts);
  els.backupLast.textContent = `Last backup: ${date.toLocaleString("en-US")}`;
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

function normalizeBackupPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  return {
    app: payload.app || "",
    app_version: payload.app_version || "",
    schema_version: payload.schema_version || payload.schemaVersion || "",
    exported_at: payload.exported_at || payload.exportedAt || null,
    templates: Array.isArray(payload.templates) ? payload.templates : [],
    instances: Array.isArray(payload.instances) ? payload.instances : [],
    payment_events: Array.isArray(payload.payment_events) ? payload.payment_events : [],
    instance_events: Array.isArray(payload.instance_events) ? payload.instance_events : [],
    month_settings: Array.isArray(payload.month_settings) ? payload.month_settings : [],
    sinking_funds: Array.isArray(payload.sinking_funds) ? payload.sinking_funds : [],
    sinking_events: Array.isArray(payload.sinking_events) ? payload.sinking_events : [],
    settings: payload.settings && typeof payload.settings === "object" ? payload.settings : null,
  };
}

function getPeriodRange(instances) {
  if (!Array.isArray(instances) || instances.length === 0) return null;
  const months = instances
    .map((inst) => {
      const y = Number(inst.year);
      const m = Number(inst.month);
      if (!Number.isInteger(y) || !Number.isInteger(m)) return null;
      return `${y}-${pad2(m)}`;
    })
    .filter(Boolean)
    .sort();
  if (months.length === 0) return null;
  return { start: months[0], end: months[months.length - 1] };
}

function summarizeBackup(payload) {
  const normalized = normalizeBackupPayload(payload);
  if (!normalized) return null;
  const range = getPeriodRange(normalized.instances);
  return {
    templates: normalized.templates.length,
    instances: normalized.instances.length,
    payments: normalized.payment_events.length,
    events: normalized.instance_events.length,
    exported_at: normalized.exported_at,
    range,
  };
}

function templateMatchKey(template) {
  const name = String(template.name || "").trim().toLowerCase();
  const due = Number(template.due_day || template.dueDay || 0);
  const amount = Number(template.amount_default || template.amountDefault || 0);
  return `${name}::${due}::${amount}`;
}

function mergeBackups(existingRaw, incomingRaw) {
  const existing = normalizeBackupPayload(existingRaw);
  const incoming = normalizeBackupPayload(incomingRaw);
  if (!existing || !incoming) return { merged: null, conflicts: 0 };

  const merged = {
    app: "au-jour-le-jour",
    app_version: existing.app_version || incoming.app_version || "",
    schema_version: existing.schema_version || incoming.schema_version || "",
    exported_at: incoming.exported_at || existing.exported_at || null,
    templates: [],
    instances: [],
    payment_events: [],
    instance_events: [],
    month_settings: [],
    sinking_funds: [],
    sinking_events: [],
    settings: existing.settings || incoming.settings || { defaults: { sort: "due_date", dueSoonDays: 7, defaultPeriod: "month" }, categories: [] },
  };

  let conflicts = 0;
  const templateMap = new Map();
  const templateFallback = new Map();
  existing.templates.forEach((tmpl) => {
    templateMap.set(String(tmpl.id), tmpl);
    templateFallback.set(templateMatchKey(tmpl), String(tmpl.id));
  });

  incoming.templates.forEach((tmpl) => {
    const id = String(tmpl.id || "");
    if (id && templateMap.has(id)) {
      conflicts += 1;
      return;
    }
    const fallbackKey = templateMatchKey(tmpl);
    if (templateFallback.has(fallbackKey)) {
      conflicts += 1;
      return;
    }
    templateMap.set(id || `incoming_${templateMap.size}`, tmpl);
    templateFallback.set(fallbackKey, id || `incoming_${templateMap.size}`);
  });
  merged.templates = Array.from(templateMap.values());

  const instanceKey = (inst) => `${String(inst.template_id || inst.templateId || inst.template || "")}|${inst.year}|${inst.month}`;
  const instanceMap = new Map();
  existing.instances.forEach((inst) => instanceMap.set(String(inst.id || instanceKey(inst)), inst));
  incoming.instances.forEach((inst) => {
    const key = String(inst.id || instanceKey(inst));
    if (instanceMap.has(key)) return;
    instanceMap.set(key, inst);
  });
  merged.instances = Array.from(instanceMap.values());

  const instanceIds = new Set(merged.instances.map((inst) => String(inst.id || "")));

  const addUnique = (existingList, incomingList, keyFn, target) => {
    const map = new Map();
    existingList.forEach((item) => map.set(keyFn(item), item));
    incomingList.forEach((item) => {
      const key = keyFn(item);
      if (!map.has(key)) map.set(key, item);
    });
    target.push(...map.values());
  };

  addUnique(existing.payment_events, incoming.payment_events, (p) => String(p.id || ""), merged.payment_events);
  merged.payment_events = merged.payment_events.filter((p) => instanceIds.has(String(p.instance_id || "")));

  addUnique(existing.instance_events, incoming.instance_events, (e) => String(e.id || ""), merged.instance_events);
  merged.instance_events = merged.instance_events.filter((e) => instanceIds.has(String(e.instance_id || "")));

  const monthMap = new Map();
  existing.month_settings.forEach((m) => monthMap.set(`${m.year}-${m.month}`, m));
  incoming.month_settings.forEach((m) => {
    const key = `${m.year}-${m.month}`;
    if (!monthMap.has(key)) monthMap.set(key, m);
  });
  merged.month_settings = Array.from(monthMap.values());

  const fundMap = new Map();
  existing.sinking_funds.forEach((f) => fundMap.set(String(f.id || ""), f));
  incoming.sinking_funds.forEach((f) => {
    const key = String(f.id || "");
    if (!fundMap.has(key)) fundMap.set(key, f);
  });
  merged.sinking_funds = Array.from(fundMap.values());

  addUnique(existing.sinking_events, incoming.sinking_events, (e) => String(e.id || ""), merged.sinking_events);

  if (existing.settings || incoming.settings) {
    const existingSettings = existing.settings || { defaults: { sort: "due_date", dueSoonDays: 7, defaultPeriod: "month" }, categories: [] };
    const incomingSettings = incoming.settings || { defaults: {}, categories: [] };
    merged.settings = {
      defaults: { ...incomingSettings.defaults, ...existingSettings.defaults },
      categories: Array.from(new Set([...(existingSettings.categories || []), ...(incomingSettings.categories || [])])),
    };
  }

  return { merged, conflicts };
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
  state.integrityStatus = "safe";
  showSystemBanner(`Safe mode: ${state.safeReason} Use Setup → Reset local data or refresh without ?safe=1.`);
  renderIntegrityStatus();
}

async function handleResetFlag() {
  const flags = getQueryFlags();
  if (!flags.reset) return false;
  try {
    await fetch("/api/reset-local", { method: "POST" });
    if (AJL_WEB_MODE) {
      try {
        localStorage.removeItem(WEB_META_KEY);
        localStorage.removeItem(BACKUP_LAST_KEY);
        localStorage.removeItem(LOCAL_EDIT_COUNT_KEY);
        localStorage.removeItem(LOCAL_BACKUP_REMINDER_KEY);
        localStorage.removeItem(JANITOR_RUNTIME_BASE_KEY);
        localStorage.removeItem(JANITOR_RUNTIME_REQUIRED_KEY);
      } catch (err) {
        // ignore
      }
    }
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
  await apiFetch(`/api/ensure-month?year=${state.selectedYear}&month=${state.selectedMonth}`, {}, { silent: true });
}

async function loadTemplates() {
  const res = await apiFetch("/api/templates");
  const data = await readApiData(res);
  state.templates = Array.isArray(data) ? data : [];
}

async function loadInstances() {
  const res = await apiFetch(
    `/api/instances?year=${state.selectedYear}&month=${state.selectedMonth}`
  );
  const data = await readApiData(res);
  state.instances = Array.isArray(data) ? data : [];
  state.dataVersion += 1;
}

async function loadPayments() {
  const res = await apiFetch(
    `/api/payments?year=${state.selectedYear}&month=${state.selectedMonth}`
  );
  const data = await readApiData(res);
  state.payments = Array.isArray(data) ? data : [];
  state.dataVersion += 1;
}

async function loadInstanceEvents(instanceId) {
  if (!instanceId) return [];
  const res = await apiFetch(`/api/instances/${instanceId}/events`);
  const data = await readApiData(res);
  const events = Array.isArray(data) ? data : [];
  state.instanceEvents[instanceId] = events;
  return events;
}

async function loadActivityEvents() {
  const res = await apiFetch(`/api/instance-events?year=${state.selectedYear}&month=${state.selectedMonth}`);
  const data = await readApiData(res);
  state.activityEvents = Array.isArray(data) ? data : [];
}

async function loadFunds() {
  const res = await apiFetch(
    `/api/sinking-funds?year=${state.selectedYear}&month=${state.selectedMonth}&include_inactive=1`
  );
  const data = await readApiData(res);
  state.funds = Array.isArray(data) ? data : [];
}

async function loadSettings() {
  const res = await apiFetch("/api/settings");
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
      share_base_url: typeof data.share_base_url === "string" ? data.share_base_url : "",
      share_viewer_base_url:
        typeof data.share_viewer_base_url === "string" ? data.share_viewer_base_url : "",
      firstRunCompleted: !!data.firstRunCompleted,
      hasCompletedOnboarding: !!(data.hasCompletedOnboarding ?? data.firstRunCompleted),
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
    const res = await apiFetch("/api/llm/qwen/oauth/status", {}, { silent: true });
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
    if (state.llmProviders?.providers?.["qwen-oauth"]) {
      state.llmProviders.providers["qwen-oauth"] = {
        ...state.llmProviders.providers["qwen-oauth"],
        connected: !!data.connected,
        last_error: data.connected ? null : state.llmProviders.providers["qwen-oauth"]?.last_error || null,
      };
    }
  } catch (err) {
    state.qwenAuth.status = "error";
  }
}

function providerDisplayName(provider) {
  const key = String(provider || "").toLowerCase();
  if (key === "openai") return "OpenAI";
  if (key === "anthropic") return "Anthropic";
  return "Qwen OAuth";
}

function getActiveProviderName() {
  return String(state.llmProviders?.active_provider || "qwen-oauth").toLowerCase();
}

function getProviderConnectionState(provider) {
  const key = String(provider || "").toLowerCase();
  const row = state.llmProviders?.providers?.[key] || {};
  const qwenPending = state.qwenAuth?.status === "pending";
  if (key === "qwen-oauth") {
    const connected = !!state.qwenAuth?.connected;
    return {
      provider: key,
      label: providerDisplayName(key),
      connected,
      configured: connected,
      pending: qwenPending,
      authUrl: state.qwenAuth?.verification_uri_complete || state.llmStatus?.auth_url || "",
      lastError: String(row.last_error || state.qwenAuth?.error || state.llmStatus?.error || ""),
      model: row.model || defaultModelForProvider(key),
      baseUrl: "",
    };
  }
  return {
    provider: key,
    label: providerDisplayName(key),
    connected: !!row.connected,
    configured: !!row.configured,
    pending: false,
    authUrl: "",
    lastError: String(row.last_error || ""),
    model: row.model || defaultModelForProvider(key),
    baseUrl: String(row.base_url || ""),
    keyHint: row.key_hint || "",
  };
}

function getActiveMamdouConnectionState() {
  const activeProvider = getActiveProviderName();
  return getProviderConnectionState(activeProvider);
}

function isActiveMamdouConnected() {
  const active = getActiveMamdouConnectionState();
  return !!active.connected;
}

function openSetupAgentSection() {
  state.view = "setup";
  renderView();
  document.getElementById("setup-agent")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function connectMamdouFlow(providerInput) {
  if (AJL_WEB_MODE) {
    return { ok: false, message: "Mamdou is available in the local app only." };
  }
  await loadLlmProviderStatus({ silent: true });
  const requestedProvider = normalizeMamdouProviderInput(providerInput || "");
  const targetProvider = requestedProvider || getActiveProviderName();
  const targetState = getProviderConnectionState(targetProvider);
  const modelOverride = targetState.model || defaultModelForProvider(targetProvider);

  if (requestedProvider) {
    const switched = await activateMamdouProvider(targetProvider, modelOverride, { silent: true });
    if (!switched.ok && targetProvider !== "qwen-oauth") {
      openSetupAgentSection();
      if (els.setupAgentProvider) els.setupAgentProvider.value = targetProvider;
      if (els.setupAgentModel) els.setupAgentModel.value = modelOverride;
      renderSetupAgentConnection();
      return {
        ok: false,
        message: `${providerDisplayName(targetProvider)} key is not configured yet. Open Setup and connect your key.`,
      };
    }
    if (switched.ok) {
      await loadLlmProviderStatus({ silent: true });
    }
  }

  const activeProvider = requestedProvider || getActiveProviderName();
  const activeState = getProviderConnectionState(activeProvider);
  if (activeProvider === "qwen-oauth") {
    if (state.qwenAuth?.connected) {
      renderAssistantConnection();
      renderSetupAgentConnection();
      return { ok: true, message: "Mamdou is already connected via Qwen." };
    }
    await startQwenAuth();
    renderAssistantConnection();
    renderSetupAgentConnection();
    if (state.qwenAuth?.verification_uri_complete) {
      return {
        ok: true,
        message: "Started Qwen login. Open login and authorize Mamdou.",
        authUrl: state.qwenAuth.verification_uri_complete,
      };
    }
    return { ok: false, message: state.qwenAuth?.error || "Unable to start Mamdou login." };
  }

  if (!activeState.configured) {
    openSetupAgentSection();
    if (els.setupAgentProvider) els.setupAgentProvider.value = activeProvider;
    if (els.setupAgentModel) {
      els.setupAgentModel.value = activeState.model || defaultModelForProvider(activeProvider);
    }
    renderSetupAgentConnection();
    return {
      ok: false,
      message: `${activeState.label} key is not configured. Connect key in Setup.`,
    };
  }

  const tested = await apiFetch(
    "/api/llm/providers/test",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: activeProvider }),
    },
    { silent: true }
  );
  if (!tested.ok) {
    const payload = await readApiData(tested).catch(() => null);
    const errorMessage = getErrorMessage(payload, `Unable to connect via ${activeState.label}.`);
    openSetupAgentSection();
    renderSetupAgentConnection();
    return { ok: false, message: errorMessage };
  }

  await loadLlmProviderStatus({ silent: true });
  await loadQwenAuthStatus();
  renderAssistantConnection();
  renderSetupAgentConnection();
  return { ok: true, message: `Mamdou connected via ${activeState.label}.` };
}

async function connectMamdouFromAssistant() {
  if (AJL_WEB_MODE) {
    showSystemBanner("Mamdou is available in the local app only.");
    return;
  }
  const provider =
    normalizeMamdouProviderInput(els.assistantProviderSelect?.value || "") || "qwen-oauth";
  if (provider !== "qwen-oauth") {
    const keyText = String(els.assistantProviderKey?.value || "").trim();
    if (keyText) {
      const keyConnect = await connectMamdouApiKey(
        provider,
        keyText,
        defaultModelForProvider(provider),
        "",
        { silent: true }
      );
      if (!keyConnect.ok) {
        showSystemBanner(keyConnect.error || `Unable to connect ${providerDisplayName(provider)}.`);
        renderAssistantConnection();
        return;
      }
      if (els.assistantProviderKey) {
        els.assistantProviderKey.value = "";
      }
      await loadLlmProviderStatus({ silent: true });
    }
  }
  const result = await connectMamdouFlow(provider);
  if (result.ok) {
    showToast(result.message || "Mamdou connected.");
    if (result.authUrl) {
      try {
        window.open(result.authUrl, "_blank", "noopener");
      } catch (err) {
        // ignore popup failures
      }
    }
  } else {
    showSystemBanner(result.message || "Unable to connect Mamdou.");
  }
  if (!result.ok && /setup/i.test(String(result.message || ""))) {
    openSetupAgentSection();
  }
  renderAssistantConnection();
  renderSetupAgentConnection();
  renderNudges();
}

function defaultModelForProvider(provider) {
  const key = String(provider || "").toLowerCase();
  if (key === "openai") return "gpt-4o-mini";
  if (key === "anthropic") return "claude-3-5-sonnet-latest";
  return "qwen3-coder-plus";
}

async function loadLlmProviderStatus(options = {}) {
  if (AJL_WEB_MODE) return;
  const silent = options.silent === true;
  try {
    const res = await apiFetch("/api/llm/providers/status", {}, { silent: true });
    if (!res.ok) return;
    const payload = await readApiData(res);
    if (!payload || typeof payload !== "object") return;
    state.llmProviders = payload;
    const active = String(payload.active_provider || "qwen-oauth");
    const activeConfig = payload.providers?.[active] || {};
    if (els.setupAgentProvider) {
      els.setupAgentProvider.value = active;
    }
    if (els.setupAgentModel) {
      els.setupAgentModel.value = String(activeConfig.model || defaultModelForProvider(active));
    }
    if (els.setupAgentBase) {
      const base = activeConfig.base_url || "";
      els.setupAgentBase.value = String(base);
    }
    renderSetupAgentConnection();
  } catch (err) {
    if (!silent) showSystemBanner("Unable to load Mamdou provider status.");
  }
}

async function activateMamdouProvider(providerInput, modelInput, options = {}) {
  if (AJL_WEB_MODE) return { ok: false, error: "Mamdou is unavailable in web mode." };
  const provider = String(providerInput || "").trim().toLowerCase();
  if (!["qwen-oauth", "openai", "anthropic"].includes(provider)) {
    return { ok: false, error: "Unsupported provider." };
  }
  const model = String(modelInput || "").trim();
  const res = await apiFetch(
    "/api/llm/providers/select",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        model: model || undefined,
      }),
    },
    { silent: true }
  );
  const payload = await readApiData(res).catch(() => null);
  if (!res.ok) {
    const message = getErrorMessage(payload, `Unable to set provider (${res.status}).`);
    if (!options.silent) showSystemBanner(message);
    return { ok: false, error: message, payload };
  }
  state.llmProviders = payload?.state || state.llmProviders;
  if (els.setupAgentProvider) els.setupAgentProvider.value = provider;
  if (els.setupAgentModel && model) els.setupAgentModel.value = model;
  return { ok: true, provider, payload };
}

async function saveLlmProviderSelection() {
  if (AJL_WEB_MODE || !els.setupAgentProvider) return;
  const provider = String(els.setupAgentProvider.value || "qwen-oauth");
  const model = String(els.setupAgentModel?.value || "").trim();
  const result = await activateMamdouProvider(provider, model);
  if (!result?.ok) return;
  showToast(`Mamdou provider set to ${provider}.`);
  renderSetupAgentConnection();
}

async function connectProviderApiKey() {
  if (AJL_WEB_MODE || !els.setupAgentProvider) return;
  const provider = String(els.setupAgentProvider.value || "").toLowerCase();
  if (!["openai", "anthropic"].includes(provider)) {
    showSystemBanner("Select OpenAI or Anthropic to connect with API key.");
    return;
  }
  const apiKey = String(els.setupAgentKey?.value || "").trim();
  if (!apiKey) {
    showSystemBanner("API key is required.");
    return;
  }
  const model = String(els.setupAgentModel?.value || "").trim() || defaultModelForProvider(provider);
  const baseUrl = String(els.setupAgentBase?.value || "").trim();
  const result = await connectMamdouApiKey(provider, apiKey, model, baseUrl, { silent: false });
  if (!result.ok) return;
  if (els.setupAgentKey) els.setupAgentKey.value = "";
  showToast(`Mamdou connected via ${provider}.`);
  await loadQwenAuthStatus();
  renderNudges();
  renderSetupAgentConnection();
}

async function connectMamdouApiKey(providerInput, apiKeyInput, modelInput, baseUrlInput, options = {}) {
  const provider = String(providerInput || "").toLowerCase();
  const apiKey = String(apiKeyInput || "").trim();
  const model = String(modelInput || "").trim() || defaultModelForProvider(provider);
  const baseUrl = String(baseUrlInput || "").trim();
  if (!["openai", "anthropic"].includes(provider)) {
    return { ok: false, error: "Provider must be OpenAI or Anthropic." };
  }
  if (!apiKey) {
    return { ok: false, error: "API key is required." };
  }
  const res = await apiFetch(
    "/api/llm/providers/connect/api-key",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        api_key: apiKey,
        model,
        base_url: baseUrl || undefined,
      }),
    },
    { silent: true }
  );
  const payload = await readApiData(res).catch(() => null);
  if (!res.ok) {
    const message = getErrorMessage(payload, `Unable to connect provider key (${res.status}).`);
    if (!options.silent) showSystemBanner(message);
    return { ok: false, error: message, payload };
  }
  state.llmProviders = payload?.state || state.llmProviders;
  return { ok: true, provider, payload };
}

async function testActiveProviderConnection() {
  if (AJL_WEB_MODE || !els.setupAgentProvider) return;
  const provider = String(els.setupAgentProvider.value || "qwen-oauth");
  const res = await apiFetch(
    "/api/llm/providers/test",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    },
    { silent: true }
  );
  const payload = await readApiData(res).catch(() => null);
  if (!res.ok) {
    const message = getErrorMessage(payload, `Mamdou test failed (${res.status}).`);
    showSystemBanner(message);
    return;
  }
  showToast(`Mamdou test passed for ${provider}.`);
  await loadLlmProviderStatus({ silent: true });
  await loadQwenAuthStatus();
  renderNudges();
  renderSetupAgentConnection();
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
  const res = await apiFetch("/api/v1/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action_id: crypto.randomUUID(), ...payload }),
  }, { silent: true });
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

async function logAutoAgentExecution(inputText, summary, proposal, outcome, meta = {}) {
  if (AJL_WEB_MODE) return;
  await logAgentCommand({
    user_text: inputText || "",
    kind: "command",
    summary: summary || summarizeProposal(proposal),
    status: outcome?.ok ? "ok" : "error",
    payload: { proposal: proposal || null, ...meta },
    result: outcome || null,
  });
  await loadCommandLog();
}

async function loadCommandLog() {
  if (AJL_WEB_MODE) {
    state.commandLog = [];
    renderCommandLog();
    return;
  }
  if (!els.llmCommandLog) return;
  try {
    const res = await apiFetch("/internal/agent/log?limit=12", {}, { silent: true });
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
    const res = await apiFetch("/api/chat?limit=50", {}, { silent: true });
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
  state.dataVersion += 1;
}

async function addPayment(instanceId, amount) {
  if (state.readOnly) return;
  const res = await apiFetch(`/api/instances/${instanceId}/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount }),
  }, { silent: true });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    window.alert(data.error || "Unable to log update.");
    return;
  }
  const data = await readApiData(res);
  if (data.instance) updateInstanceInState(data.instance);
  flashRow(instanceId);
  await loadPayments();
  await loadActivityEvents();
  renderDashboard();
  recordMutation();
  scheduleSharePublish();
}

function normalizeInstanceIds(instanceIds) {
  if (!Array.isArray(instanceIds)) return [];
  const seen = new Set();
  const ids = [];
  for (const value of instanceIds) {
    const id = String(value || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function markInstancesDone(instanceIds) {
  if (state.readOnly) return { ok: false, error: "Read-only mode." };
  const ids = normalizeInstanceIds(instanceIds);
  if (ids.length === 0) return { ok: false, error: "No items selected.", done: 0, total: 0, failed: [] };
  const failed = [];
  for (const id of ids) {
    const result = await postAction({
      type: "MARK_PAID",
      instance_id: id,
      paid_date: getTodayDateString(),
    });
    if (!result || result.ok === false) {
      failed.push({ id, error: getErrorMessage(result, "Unable to mark done.") });
      continue;
    }
    if (result.instance) updateInstanceInState(result.instance);
  }
  const done = ids.length - failed.length;
  if (done > 0) {
    await loadPayments();
    await loadActivityEvents();
    renderDashboard();
    recordMutation();
    scheduleSharePublish();
  }
  return {
    ok: failed.length === 0,
    total: ids.length,
    done,
    failed,
  };
}

async function markInstancesPending(instanceIds) {
  if (state.readOnly) return { ok: false, error: "Read-only mode." };
  const ids = normalizeInstanceIds(instanceIds);
  if (ids.length === 0) return { ok: false, error: "No items selected.", done: 0, total: 0, failed: [] };
  const failed = [];
  for (const id of ids) {
    const result = await postAction({
      type: "MARK_PENDING",
      instance_id: id,
    });
    if (!result || result.ok === false) {
      failed.push({ id, error: getErrorMessage(result, "Unable to undo.") });
      continue;
    }
    if (result.instance) updateInstanceInState(result.instance);
  }
  const done = ids.length - failed.length;
  if (done > 0) {
    await loadPayments();
    await loadActivityEvents();
    renderDashboard();
    recordMutation();
    scheduleSharePublish();
  }
  return {
    ok: failed.length === 0,
    total: ids.length,
    done,
    failed,
  };
}

async function markPaid(instanceId, options = {}) {
  const outcome = await markInstancesDone([instanceId]);
  if (!outcome.ok && outcome.done === 0) {
    window.alert(outcome.failed?.[0]?.error || outcome.error || "Unable to mark done.");
    return;
  }
  if (!options.silent) {
    showToast("Marked done.", "Undo", () => markPending(instanceId));
  }
}

async function markPending(instanceId) {
  const outcome = await markInstancesPending([instanceId]);
  if (!outcome.ok && outcome.done === 0) {
    window.alert(outcome.failed?.[0]?.error || outcome.error || "Unable to undo.");
    return;
  }
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
  if (state.readOnly) return;
  const res = await apiFetch(`/api/payments/${paymentId}`, { method: "DELETE" }, { silent: true });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    window.alert(data.error || "Unable to undo update.");
    return;
  }
  const data = await readApiData(res);
  if (data.instance) updateInstanceInState(data.instance);
  await loadPayments();
  await loadActivityEvents();
  renderDashboard();
  recordMutation();
  scheduleSharePublish();
}

async function patchInstance(id, body) {
  if (state.readOnly) return;
  const res = await apiFetch(`/api/instances/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, { silent: true });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    window.alert(data.error || "Unable to update item.");
    return;
  }
  const updated = await readApiData(res);
  updateInstanceInState(updated);
  await loadActivityEvents();
  renderDashboard();
  recordMutation();
  scheduleSharePublish();
}

function deriveInstances() {
  const totals = new Map();
  state.payments.forEach((payment) => {
    const key = payment.instance_id;
    const sum = totals.get(key) || 0;
    totals.set(key, sum + Number(payment.amount || 0));
  });

  return state.instances.map((item) => {
    if (isSharedAmountsHidden()) {
      const baseStatus = String(item.status || "").toLowerCase();
      const status =
        baseStatus === "skipped"
          ? "skipped"
          : baseStatus === "paid"
          ? "paid"
          : baseStatus === "partial"
          ? "partial"
          : "pending";
      const dueAmount = item.amount == null ? null : Number(item.amount || 0);
      const paidAmount = item.amount_paid == null ? null : Number(item.amount_paid || 0);
      let remainingAmount =
        item.amount_remaining == null
          ? status === "paid" || status === "skipped"
            ? 0
            : 1
          : Number(item.amount_remaining || 0);
      if (status === "paid" || status === "skipped") {
        remainingAmount = 0;
      }
      return {
        ...item,
        amount: dueAmount,
        amount_paid: paidAmount,
        amount_remaining: remainingAmount,
        status_derived: status,
      };
    }

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
      status_derived: status,
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

function getShareOwnerLabelValue() {
  if (els.shareOwnerLabel) {
    return String(els.shareOwnerLabel.value || "").trim().slice(0, 120);
  }
  return String(state.shareOwnerLabel || "").trim().slice(0, 120);
}

function inferShareExpiryPreset(expiresAt) {
  if (!expiresAt) return "never";
  const targetTs = new Date(expiresAt).getTime();
  if (!Number.isFinite(targetTs)) return "custom";
  const delta = targetTs - Date.now();
  if (delta <= 0) return "custom";
  const day = 24 * 60 * 60 * 1000;
  if (Math.abs(delta - day) < 2 * 60 * 60 * 1000) return "24h";
  if (Math.abs(delta - 7 * day) < 6 * 60 * 60 * 1000) return "7d";
  if (Math.abs(delta - 30 * day) < 12 * 60 * 60 * 1000) return "30d";
  return "custom";
}

function getShareExpiryPresetValue() {
  if (els.shareExpiry) {
    const value = String(els.shareExpiry.value || "never");
    return value || "never";
  }
  return state.shareExpiryPreset || "never";
}

function toDatetimeLocalInputValue(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function fromDatetimeLocalInputValue(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function setShareExpiryCustomVisibility(show) {
  if (!els.shareExpiryCustomWrap) return;
  els.shareExpiryCustomWrap.classList.toggle("hidden", !show);
}

function buildExpiresAtFromPreset(preset) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  switch (String(preset || "never")) {
    case "24h":
      return new Date(now + day).toISOString();
    case "7d":
      return new Date(now + 7 * day).toISOString();
    case "30d":
      return new Date(now + 30 * day).toISOString();
    case "never":
      return null;
    case "custom":
      return fromDatetimeLocalInputValue(els.shareExpiryCustom?.value || "") || state.shareInfo?.expires_at || null;
    default:
      return null;
  }
}

function getShareExpiryValue(options = {}) {
  const allowPast = !!options.allowPast;
  const preset = getShareExpiryPresetValue();
  state.shareExpiryPreset = preset;
  const expiresAt = buildExpiresAtFromPreset(preset);
  if (!expiresAt || allowPast) return expiresAt;
  const expiryTs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiryTs) || expiryTs <= Date.now()) {
    return null;
  }
  return expiresAt;
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

function getSummaryTotals(list) {
  const key = `${state.selectedYear}-${state.selectedMonth}-${state.essentialsOnly}-${state.dataVersion}`;
  if (state.summaryCache && state.summaryCache.key === key) {
    return state.summaryCache.totals;
  }
  const totals = computeTotals(list);
  state.summaryCache = { key, totals };
  return totals;
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

function tokenizeAgentText(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3)
    .slice(0, 12);
}

function pickRelevantInstancesForAgent(base, userText) {
  const prioritized = prioritizeInstancesForAgent(base);
  const tokens = tokenizeAgentText(userText);
  const byId = new Map();

  const selected = prioritized.find((item) => item.id === state.selectedInstanceId);
  if (selected) byId.set(selected.id, selected);

  if (tokens.length > 0) {
    for (const item of prioritized) {
      const haystack = `${item.name_snapshot || ""} ${item.category_snapshot || ""}`.toLowerCase();
      const matched = tokens.some((token) => haystack.includes(token));
      if (!matched) continue;
      byId.set(item.id, item);
      if (byId.size >= Math.floor(MAX_LLM_INSTANCES / 2)) break;
    }
  }

  for (const item of prioritized) {
    if (byId.size >= MAX_LLM_INSTANCES) break;
    byId.set(item.id, item);
  }

  return Array.from(byId.values()).slice(0, MAX_LLM_INSTANCES);
}

function pickRelevantTemplatesForAgent(templates, userText) {
  const tokens = tokenizeAgentText(userText);
  if (tokens.length === 0) return templates.slice(0, MAX_LLM_TEMPLATES);
  const ranked = templates
    .map((tmpl) => {
      const haystack = `${tmpl.name || ""} ${tmpl.category || ""}`.toLowerCase();
      const score = tokens.reduce((sum, token) => (haystack.includes(token) ? sum + 1 : sum), 0);
      return { tmpl, score };
    })
    .sort((a, b) => b.score - a.score || String(a.tmpl.name).localeCompare(String(b.tmpl.name)));
  const focused = ranked.filter((entry) => entry.score > 0).map((entry) => entry.tmpl);
  const fallback = ranked.filter((entry) => entry.score === 0).map((entry) => entry.tmpl);
  return [...focused, ...fallback].slice(0, MAX_LLM_TEMPLATES);
}

function pickRelevantFundsForAgent(funds, userText) {
  const tokens = tokenizeAgentText(userText);
  if (tokens.length === 0) return funds.slice(0, MAX_LLM_FUNDS);
  const ranked = funds
    .map((fund) => {
      const haystack = `${fund.name || ""} ${fund.category || ""}`.toLowerCase();
      const score = tokens.reduce((sum, token) => (haystack.includes(token) ? sum + 1 : sum), 0);
      return { fund, score };
    })
    .sort((a, b) => b.score - a.score || String(a.fund.name).localeCompare(String(b.fund.name)));
  const focused = ranked.filter((entry) => entry.score > 0).map((entry) => entry.fund);
  const fallback = ranked.filter((entry) => entry.score === 0).map((entry) => entry.fund);
  return [...focused, ...fallback].slice(0, MAX_LLM_FUNDS);
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
  const relevantInstances = pickRelevantInstancesForAgent(base, userText);
  const selectedInstance = base.find((item) => item.id === state.selectedInstanceId) || null;
  const knownInstances = relevantInstances.map((item) => ({
    name: item.name_snapshot,
    remaining: item.amount_remaining,
    status: item.status_derived,
    due_date: item.due_date,
  }));
  const knownTemplates = pickRelevantTemplatesForAgent(state.templates, userText).map((t) => ({
    name: t.name,
    active: t.active,
  }));
  const knownFunds = pickRelevantFundsForAgent(state.funds || [], userText).map((f) => ({
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
    selected_instance:
      selectedInstance ?
        {
          name: selectedInstance.name_snapshot,
          remaining: selectedInstance.amount_remaining,
          status: selectedInstance.status_derived,
          due_date: selectedInstance.due_date,
        } :
        null,
    known_instances: knownInstances,
    known_templates: knownTemplates,
    known_funds: knownFunds,
    recent_payments: recentPayments,
  };
}

function normalizeQuickTarget(raw) {
  return String(raw || "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .replace(/\s+/g, " ");
}

const FAST_MONTH_MAP = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function shiftYearMonth(year, month, delta) {
  const index = year * 12 + (month - 1) + delta;
  if (!Number.isFinite(index)) return { year, month };
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  return { year: nextYear, month: nextMonth };
}

function parseFastMonthIntent(input) {
  const text = String(input || "").toLowerCase();
  const match = text.match(/\b(20\d{2})-(0[1-9]|1[0-2])\b/);
  const normalized = text.replace(/^(?:go\s+to|open|switch\s+to|set)\s+/, "");
  let year = NaN;
  let month = NaN;
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
  } else if (/^(?:next|forward)\s+month$/.test(normalized)) {
    const next = shiftYearMonth(state.selectedYear, state.selectedMonth, 1);
    year = next.year;
    month = next.month;
  } else if (/^(?:prev(?:ious)?|last|back)\s+month$/.test(normalized)) {
    const prev = shiftYearMonth(state.selectedYear, state.selectedMonth, -1);
    year = prev.year;
    month = prev.month;
  } else if (/^(?:this|current)\s+month$/.test(normalized)) {
    year = state.selectedYear;
    month = state.selectedMonth;
  } else {
    const named = text.match(
      /^(?:go\s+to\s+|open\s+|switch\s+to\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(20\d{2}))?$/
    );
    if (named) {
      month = Number(FAST_MONTH_MAP[String(named[1] || "").toLowerCase()] || 0);
      year = named[2] ? Number(named[2]) : state.selectedYear;
    }
  }
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  return {
    intent: "SET_MONTH",
    confidence: 0.99,
    needs_confirmation: true,
    target: { type: "month", period: `${year}-${pad2(month)}` },
    payload: { year, month },
  };
}

function parseFastAmount(text) {
  const cleaned = String(text || "").replace(/,/g, "");
  const match = cleaned.match(/\$?\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return NaN;
  return Number(match[1]);
}

function splitTargetNames(raw) {
  if (!raw) return [];
  const normalized = String(raw)
    .replace(/\s+and\s+/gi, ",")
    .replace(/\s*&\s*/g, ",")
    .replace(/\s*;\s*/g, ",");
  const seen = new Set();
  const values = [];
  normalized.split(",").forEach((part) => {
    const name = normalizeQuickTarget(part);
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    values.push(name);
  });
  return values;
}

function parseFastTemplateIntent(input) {
  const text = String(input || "").trim();
  const lower = text.toLowerCase();
  if (!lower.startsWith("add ") && !lower.startsWith("create ")) return null;
  if (!lower.includes("$") && !/\b\d+(?:\.\d+)?\b/.test(lower)) return null;
  const amount = parseFastAmount(text);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const dueDayMatch = lower.match(/\b(?:due|on)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  const dueDay = dueDayMatch ? Math.max(1, Math.min(31, Number(dueDayMatch[1]))) : 1;

  let namePart = text
    .replace(/^\s*(add|create)\s+/i, "")
    .replace(/\$?\s*-?\d+(?:\.\d+)?/i, "")
    .replace(/\b(?:a|per)?\s*month(?:ly)?\b/i, "")
    .replace(/\b(?:due|on)\s+\d{1,2}(?:st|nd|rd|th)?\b/i, "")
    .trim();
  namePart = normalizeQuickTarget(namePart);
  if (!namePart) return null;

  return {
    intent: "CREATE_TEMPLATE",
    confidence: 0.96,
    needs_confirmation: true,
    target: { type: "template", name: namePart },
    payload: {
      name: namePart,
      amount_default: amount,
      due_day: dueDay,
      essential: true,
      active: true,
    },
  };
}

function parseFastBulkTemplateIntent(input) {
  const text = String(input || "");
  const lines = text
    .split(/\r?\n+/)
    .map((line) =>
      line
        .replace(/^[\s>*\-•\d.)]+/, "")
        .trim()
    )
    .filter(Boolean);
  if (lines.length < 2) return null;
  const templates = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!line || lower.includes("monthly total") || lower.includes("new total")) continue;
    const match =
      line.match(/^(.*?)\s*(?:[-—:])\s*\$?\s*(-?\d[\d,]*(?:\.\d+)?)\s*$/) ||
      line.match(/^(.*?)\s+\$?\s*(-?\d[\d,]*(?:\.\d+)?)\s*$/);
    if (!match) continue;
    const name = normalizeQuickTarget(match[1]);
    const amount = parseFastAmount(match[2]);
    if (!name || !Number.isFinite(amount) || amount <= 0) continue;
    templates.push({
      name,
      category: null,
      amount_default: Number(amount.toFixed(2)),
      due_day_guess: 1,
      essential_guess: true,
      autopay_guess: false,
      notes: null,
    });
  }
  if (templates.length < 2) return null;
  return {
    intent: "CREATE_TEMPLATES_BULK",
    confidence: 0.97,
    needs_confirmation: true,
    target: { type: "template", name: null },
    payload: { templates },
  };
}

function parseFastEssentialsIntent(input) {
  const text = String(input || "").trim().toLowerCase();
  if (
    /^(?:essentials(?:\s+only)?\s+on|turn\s+on\s+essentials(?:\s+only)?|show\s+essentials(?:\s+only)?)$/.test(
      text
    )
  ) {
    return {
      intent: "SET_ESSENTIALS_ONLY",
      confidence: 0.98,
      needs_confirmation: true,
      target: { type: "none", name: null },
      payload: { essentials_only: true },
    };
  }
  if (
    /^(?:essentials(?:\s+only)?\s+off|turn\s+off\s+essentials(?:\s+only)?|show\s+all(?:\s+bills)?|all\s+bills)$/.test(
      text
    )
  ) {
    return {
      intent: "SET_ESSENTIALS_ONLY",
      confidence: 0.98,
      needs_confirmation: true,
      target: { type: "none", name: null },
      payload: { essentials_only: false },
    };
  }
  return null;
}

function parseFastExportIntent(input) {
  const text = String(input || "").trim().toLowerCase();
  if (/^(?:export|download)\s+(?:month|monthly)\s+(?:csv|report)?$/.test(text)) {
    return {
      intent: "EXPORT_MONTH",
      confidence: 0.97,
      needs_confirmation: false,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  if (/^(?:export|download)\s+(?:backup|json|full\s+backup)$/.test(text)) {
    return {
      intent: "EXPORT_BACKUP",
      confidence: 0.97,
      needs_confirmation: false,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  return null;
}

function parseFastBatchQueueIntent(input) {
  const text = String(input || "").trim().toLowerCase();
  if (/^(?:mark|set)\s+all\s+overdue\s+(?:done|paid|complete(?:d)?)$/.test(text)) {
    return {
      intent: "MARK_ALL_OVERDUE",
      confidence: 0.98,
      needs_confirmation: true,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  if (/^(?:mark|set)\s+all\s+(?:due\s*soon|soon)\s+(?:done|paid|complete(?:d)?)$/.test(text)) {
    return {
      intent: "MARK_ALL_DUE_SOON",
      confidence: 0.98,
      needs_confirmation: true,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  return null;
}

function parseFastTemplateMutationIntent(input) {
  const text = String(input || "").trim();
  const deleteMatch = text.match(/^(?:delete|remove)\s+templates?\s+(.+)$/i);
  if (deleteMatch) {
    const names = splitTargetNames(deleteMatch[1]);
    if (names.length > 1) {
      return {
        intent: "DELETE_TEMPLATES_BULK",
        confidence: 0.95,
        needs_confirmation: true,
        target: { type: "template", name: null },
        payload: { names },
      };
    }
    return {
      intent: "DELETE_TEMPLATE",
      confidence: 0.96,
      needs_confirmation: true,
      target: { type: "template", name: names[0] || normalizeQuickTarget(deleteMatch[1]) },
      payload: {},
    };
  }
  const archiveMatch = text.match(/^(?:archive|disable)\s+templates?\s+(.+)$/i);
  if (archiveMatch) {
    const names = splitTargetNames(archiveMatch[1]);
    if (names.length > 1) {
      return {
        intent: "ARCHIVE_TEMPLATES_BULK",
        confidence: 0.95,
        needs_confirmation: true,
        target: { type: "template", name: null },
        payload: { names },
      };
    }
    return {
      intent: "ARCHIVE_TEMPLATE",
      confidence: 0.96,
      needs_confirmation: true,
      target: { type: "template", name: names[0] || normalizeQuickTarget(archiveMatch[1]) },
      payload: {},
    };
  }
  const activateMatch = text.match(/^(?:activate|enable|restore|unarchive)\s+templates?\s+(.+)$/i);
  if (activateMatch) {
    const names = splitTargetNames(activateMatch[1]);
    if (names.length > 1) {
      return {
        intent: "ACTIVATE_TEMPLATES_BULK",
        confidence: 0.95,
        needs_confirmation: true,
        target: { type: "template", name: null },
        payload: { names },
      };
    }
    return {
      intent: "UPDATE_TEMPLATE",
      confidence: 0.95,
      needs_confirmation: true,
      target: { type: "template", name: names[0] || normalizeQuickTarget(activateMatch[1]) },
      payload: { active: true },
    };
  }
  const updateAmountMatch = text.match(
    /^(?:set|update)\s+template\s+(.+?)\s+(?:to|=)\s*\$?\s*(\d+(?:\.\d+)?)(?:\s+(?:due|on)\s*(\d{1,2}))?$/i
  );
  if (updateAmountMatch) {
    const amount = Number(updateAmountMatch[2]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const payload = { amount_default: amount };
    const dueDay = Number(updateAmountMatch[3] || NaN);
    if (Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31) {
      payload.due_day = dueDay;
    }
    return {
      intent: "UPDATE_TEMPLATE",
      confidence: 0.95,
      needs_confirmation: true,
      target: { type: "template", name: normalizeQuickTarget(updateAmountMatch[1]) },
      payload,
    };
  }
  return null;
}

function parseFastInstanceMutationIntent(input) {
  const text = String(input || "").trim();

  const amountBillMatch = text.match(
    /^(?:set|update)\s+bill\s+(.+?)\s+(?:amount|amt)\s*(?:to|=)\s*\$?\s*(\d+(?:\.\d+)?)$/i
  );
  if (amountBillMatch) {
    const amount = Number(amountBillMatch[2]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return {
      intent: "UPDATE_INSTANCE_FIELDS",
      confidence: 0.95,
      needs_confirmation: true,
      target: { type: "instance", name: normalizeQuickTarget(amountBillMatch[1]) },
      payload: { amount },
    };
  }

  const amountGenericMatch = text.match(
    /^(?:set|update)\s+(?:amount|amt)\s+(?:for|of)\s+(.+?)\s*(?:to|=)\s*\$?\s*(\d+(?:\.\d+)?)$/i
  );
  if (amountGenericMatch) {
    const amount = Number(amountGenericMatch[2]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return {
      intent: "UPDATE_INSTANCE_FIELDS",
      confidence: 0.94,
      needs_confirmation: true,
      target: { type: "instance", name: normalizeQuickTarget(amountGenericMatch[1]) },
      payload: { amount },
    };
  }

  const dueMatch = text.match(
    /^(?:set|update)\s+bill\s+(.+?)\s+due(?:\s+date)?\s*(?:to|=)\s*(\d{4}-\d{2}-\d{2})$/i
  );
  if (dueMatch) {
    return {
      intent: "UPDATE_INSTANCE_FIELDS",
      confidence: 0.95,
      needs_confirmation: true,
      target: { type: "instance", name: normalizeQuickTarget(dueMatch[1]) },
      payload: { due_date: dueMatch[2] },
    };
  }

  const noteMatch = text.match(/^(?:set|update)\s+bill\s+(.+?)\s+note\s*(?:to|=)\s+(.+)$/i);
  if (noteMatch) {
    const note = String(noteMatch[2] || "").trim();
    if (!note) return null;
    return {
      intent: "UPDATE_INSTANCE_FIELDS",
      confidence: 0.92,
      needs_confirmation: true,
      target: { type: "instance", name: normalizeQuickTarget(noteMatch[1]) },
      payload: { note },
    };
  }

  const flexAmountMatch = text.match(
    /^(?:set|update|change)\s+(.+?)\s+(?:to|=)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:monthly|month|\/mo|mo)?$/i
  );
  if (flexAmountMatch) {
    const target = normalizeQuickTarget(flexAmountMatch[1]);
    const blockedTargets = new Set([
      "month",
      "this month",
      "next month",
      "previous month",
      "essentials",
      "summary",
      "today",
    ]);
    if (!target || blockedTargets.has(target.toLowerCase())) return null;
    const amount = Number(flexAmountMatch[2]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return {
      intent: "UPDATE_AMOUNT_FLEX",
      confidence: 0.9,
      needs_confirmation: true,
      target: { type: "none", name: target },
      payload: { amount },
    };
  }

  return null;
}

function parseFastBulkInstanceIntent(input) {
  const text = String(input || "").trim();
  const doneMatch =
    text.match(/^(?:mark|set)\s+done\s+(.+)$/i) ||
    text.match(/^(?:mark|set)\s+(.+)\s+done$/i);
  if (doneMatch) {
    const names = splitTargetNames(doneMatch[1]);
    if (names.length > 1) {
      return {
        intent: "MARK_INSTANCES_BULK_DONE",
        confidence: 0.95,
        needs_confirmation: true,
        target: { type: "instance", name: null },
        payload: { names },
      };
    }
  }

  const pendingMatch = text.match(/^(?:mark|set)\s+pending\s+(.+)$/i);
  if (pendingMatch) {
    const names = splitTargetNames(pendingMatch[1]);
    if (names.length > 1) {
      return {
        intent: "MARK_INSTANCES_BULK_PENDING",
        confidence: 0.95,
        needs_confirmation: true,
        target: { type: "instance", name: null },
        payload: { names },
      };
    }
  }

  const skipMatch = text.match(/^(?:skip|archive)\s+(.+)$/i);
  if (skipMatch) {
    const names = splitTargetNames(skipMatch[1]);
    if (names.length > 1) {
      return {
        intent: "SKIP_INSTANCES_BULK",
        confidence: 0.95,
        needs_confirmation: true,
        target: { type: "instance", name: null },
        payload: { names },
      };
    }
  }
  return null;
}

function parseFastShareIntent(input) {
  const text = String(input || "").trim().toLowerCase();
  if (/^(?:show|open)\s+share(?:\s+link)?$/.test(text) || /^share\s+link$/.test(text)) {
    return {
      intent: "SHOW_SHARE",
      confidence: 0.98,
      needs_confirmation: false,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  if (/^(?:create|new|enable)\s+share(?:\s+link)?$/.test(text)) {
    return {
      intent: "CREATE_SHARE",
      confidence: 0.97,
      needs_confirmation: true,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  if (/^(?:refresh|update)\s+share(?:\s+link)?$/.test(text)) {
    return {
      intent: "REFRESH_SHARE",
      confidence: 0.97,
      needs_confirmation: true,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  if (/^(?:disable|turn\s+off)\s+share(?:\s+link)?$/.test(text)) {
    return {
      intent: "DISABLE_SHARE",
      confidence: 0.97,
      needs_confirmation: true,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  if (/^(?:regenerate|rotate|renew)\s+share(?:\s+link)?$/.test(text)) {
    return {
      intent: "REGENERATE_SHARE",
      confidence: 0.97,
      needs_confirmation: true,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  if (/^copy\s+share(?:\s+link)?$/.test(text)) {
    return {
      intent: "COPY_SHARE",
      confidence: 0.98,
      needs_confirmation: false,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  return null;
}

function normalizeMamdouProviderInput(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  if (["qwen", "qwen-oauth", "qwen oauth", "qwenoauth"].includes(value)) return "qwen-oauth";
  if (["openai", "gpt", "chatgpt"].includes(value)) return "openai";
  if (["anthropic", "claude"].includes(value)) return "anthropic";
  return "";
}

function parseFastAssistantIntent(input) {
  const text = String(input || "").trim().toLowerCase();
  const providerMatch =
    text.match(/^(?:connect|start|login)\s+(?:assistant|mamdou|agent)\s+(?:with|to|using)\s+([a-z0-9\- ]+)$/) ||
    text.match(/^(?:connect|start|login)\s+(qwen|openai|anthropic|claude|gpt)\s+(?:assistant|mamdou|agent)$/) ||
    text.match(/^(?:use|switch(?:\s+to)?)\s+(qwen|openai|anthropic|claude|gpt)\s+(?:for\s+)?(?:assistant|mamdou|agent)?$/);
  if (providerMatch) {
    const provider = normalizeMamdouProviderInput(providerMatch[1]);
    if (provider) {
      return {
        intent: "START_AGENT_AUTH",
        confidence: 0.98,
        needs_confirmation: false,
        target: { type: "none", name: null },
        payload: { provider },
      };
    }
  }
  if (/^(?:open|show)\s+(?:assistant|mamdou|agent)$/.test(text)) {
    return {
      intent: "SHOW_ASSISTANT",
      confidence: 0.98,
      needs_confirmation: false,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  if (/^(?:connect|start|login)\s+(?:assistant|mamdou|agent)$/.test(text)) {
    return {
      intent: "START_AGENT_AUTH",
      confidence: 0.97,
      needs_confirmation: false,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  return null;
}

function parseFastQuestionIntent(input) {
  const text = String(input || "").trim().toLowerCase();
  if (!text) return null;
  if (
    /^(?:how much|what(?:'s| is)?|show)\s+(?:is\s+)?(?:left|remaining)(?:\s+this\s+month)?\??$/.test(text) ||
    /^(?:remaining(?:\s+this\s+month)?)\??$/.test(text)
  ) {
    return {
      intent: "LOCAL_SUMMARY_REMAINING",
      confidence: 0.99,
      needs_confirmation: false,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  if (/^(?:how many|what(?:'s| is)?|show)\s+overdue(?:\s+bills?)?\??$/.test(text) || /^overdue\??$/.test(text)) {
    return {
      intent: "LOCAL_SUMMARY_OVERDUE",
      confidence: 0.99,
      needs_confirmation: false,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  if (
    /^(?:how many|what(?:'s| is)?|show)\s+(?:due\s*soon|due\s+next\s+7\s+days)(?:\s+bills?)?\??$/.test(text) ||
    /^due\s*soon\??$/.test(text)
  ) {
    return {
      intent: "LOCAL_SUMMARY_DUE_SOON",
      confidence: 0.99,
      needs_confirmation: false,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  if (/^(?:am\s+i|are\s+we)\s+free(?:\s+for\s+the\s+month)?\??$/.test(text) || /^free\s+for\s+the\s+month\??$/.test(text)) {
    return {
      intent: "LOCAL_SUMMARY_FREE",
      confidence: 0.99,
      needs_confirmation: false,
      target: { type: "none", name: null },
      payload: {},
    };
  }
  return null;
}

function parseFastCommand(userText) {
  const text = String(userText || "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  if (/^(show|open)\s+overdue\b/.test(lower)) {
    return { intent: "SHOW_OVERDUE", confidence: 0.99, needs_confirmation: false, target: { type: "none", name: null }, payload: {} };
  }
  if (/^(show|open)\s+due\s+soon\b/.test(lower)) {
    return { intent: "SHOW_DUE_SOON", confidence: 0.99, needs_confirmation: false, target: { type: "none", name: null }, payload: {} };
  }
  if (/^(show|open)\s+templates\b/.test(lower)) {
    return { intent: "SHOW_TEMPLATES", confidence: 0.99, needs_confirmation: false, target: { type: "none", name: null }, payload: {} };
  }
  if (/^(show|open)\s+(summary|dashboard|today)\b/.test(lower)) {
    return { intent: "SHOW_SUMMARY", confidence: 0.99, needs_confirmation: false, target: { type: "none", name: null }, payload: {} };
  }
  if (/^(show|open)\s+(backup|export)\b/.test(lower)) {
    return { intent: "SHOW_BACKUP", confidence: 0.99, needs_confirmation: false, target: { type: "none", name: null }, payload: {} };
  }
  if (/^(show|open)\s+(piggy|fund|funds)\b/.test(lower)) {
    return { intent: "SHOW_PIGGY", confidence: 0.99, needs_confirmation: false, target: { type: "none", name: null }, payload: {} };
  }

  const essentialsIntent = parseFastEssentialsIntent(text);
  if (essentialsIntent) return essentialsIntent;

  const exportIntent = parseFastExportIntent(text);
  if (exportIntent) return exportIntent;

  const batchIntent = parseFastBatchQueueIntent(text);
  if (batchIntent) return batchIntent;

  const monthIntent = parseFastMonthIntent(text);
  if (monthIntent) return monthIntent;

  const bulkTemplateIntent = parseFastBulkTemplateIntent(text);
  if (bulkTemplateIntent) return bulkTemplateIntent;

  const templateMutationIntent = parseFastTemplateMutationIntent(text);
  if (templateMutationIntent) return templateMutationIntent;

  const templateIntent = parseFastTemplateIntent(text);
  if (templateIntent) return templateIntent;

  const instanceMutationIntent = parseFastInstanceMutationIntent(text);
  if (instanceMutationIntent) return instanceMutationIntent;

  const bulkInstanceIntent = parseFastBulkInstanceIntent(text);
  if (bulkInstanceIntent) return bulkInstanceIntent;

  const shareIntent = parseFastShareIntent(text);
  if (shareIntent) return shareIntent;

  const assistantIntent = parseFastAssistantIntent(text);
  if (assistantIntent) return assistantIntent;

  const questionIntent = parseFastQuestionIntent(text);
  if (questionIntent) return questionIntent;

  const skipMatch = text.match(/^(?:skip|archive)\s+(.+)$/i);
  if (skipMatch) {
    return {
      intent: "SKIP_INSTANCE",
      confidence: 0.95,
      needs_confirmation: true,
      target: { type: "instance", name: normalizeQuickTarget(skipMatch[1]) },
      payload: {},
    };
  }

  const pendingMatch = text.match(/^(?:unskip|mark\s+pending|undo\s+done)\s+(.+)$/i);
  if (pendingMatch) {
    return {
      intent: "MARK_PENDING",
      confidence: 0.95,
      needs_confirmation: true,
      target: { type: "instance", name: normalizeQuickTarget(pendingMatch[1]) },
      payload: {},
    };
  }

  const doneMatch = text.match(/^(?:mark|set)?\s*(.+?)\s+(?:done|paid|complete(?:d)?)$/i);
  if (doneMatch) {
    return {
      intent: "MARK_PAID",
      confidence: 0.96,
      needs_confirmation: true,
      target: { type: "instance", name: normalizeQuickTarget(doneMatch[1]) },
      payload: {},
    };
  }

  const payFullMatch = text.match(/^(?:done|pay\s+full)\s+(.+)$/i);
  if (payFullMatch) {
    return {
      intent: "ADD_PAYMENT",
      confidence: 0.95,
      needs_confirmation: true,
      target: { type: "instance", name: normalizeQuickTarget(payFullMatch[1]) },
      payload: { amount_mode: "FULL_REMAINING" },
    };
  }

  const fractionMatch = text.match(/^(?:pay|log|add)\s+(half|quarter)\s+(.+)$/i);
  if (fractionMatch) {
    const fraction = fractionMatch[1].toLowerCase() === "quarter" ? 0.25 : 0.5;
    return {
      intent: "ADD_PAYMENT",
      confidence: 0.92,
      needs_confirmation: true,
      target: { type: "instance", name: normalizeQuickTarget(fractionMatch[2]) },
      payload: { amount_mode: "FRACTION", fraction },
    };
  }

  const amountMatch = text.match(/^(?:pay|log|add)\s+\$?\s*(-?\d+(?:\.\d+)?)\s+(?:to|for)?\s*(.+)$/i);
  if (amountMatch) {
    const amount = Number(amountMatch[1]);
    if (Number.isFinite(amount) && amount > 0) {
      return {
        intent: "ADD_PAYMENT",
        confidence: 0.93,
        needs_confirmation: true,
        target: { type: "instance", name: normalizeQuickTarget(amountMatch[2]) },
        payload: { amount_mode: "FIXED", amount },
      };
    }
  }

  const payNameMatch = text.match(/^pay\s+(.+)$/i);
  if (payNameMatch) {
    return {
      intent: "ADD_PAYMENT",
      confidence: 0.92,
      needs_confirmation: true,
      target: { type: "instance", name: normalizeQuickTarget(payNameMatch[1]) },
      payload: { amount_mode: "FULL_REMAINING" },
    };
  }

  return null;
}

function renderSummary(list) {
  const totals = getSummaryTotals(list);
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

  const hideAmounts = isSharedAmountsHidden();
  els.requiredAmount.textContent = formatMoneyDisplay(totals.required);
  els.paidAmount.textContent = formatMoneyDisplay(totals.paid);
  els.remainingAmount.textContent = formatMoneyDisplay(totals.remaining);
  if (els.miniRemainingAmount) els.miniRemainingAmount.textContent = formatMoneyDisplay(totals.remaining);
  if (els.miniDoneAmount) els.miniDoneAmount.textContent = formatMoneyDisplay(totals.paid);
  els.needDay.textContent = hideAmounts ? "Hidden" : formatMoney(needDailyExact);
  els.needWeek.textContent = hideAmounts ? "Hidden" : formatMoney(needWeeklyExact);
  els.needDayPlan.textContent = hideAmounts
    ? "Planning avg: Hidden"
    : `Planning avg: ${formatMoney(needDailyPlan)}/day`;
  els.needWeekPlan.textContent = hideAmounts
    ? "Planning avg: Hidden"
    : `Planning avg: ${formatMoney(needWeeklyPlan)}/week`;

  if (els.summaryPanel) {
    els.summaryPanel.classList.toggle("expanded", state.summaryExpanded);
    els.summaryPanel.classList.toggle("collapsed", !state.summaryExpanded);
  }
  if (els.statusExpand) {
    els.statusExpand.textContent = state.summaryExpanded ? "Hide summary" : "View summary";
  }

  if (els.summaryCountRemaining) els.summaryCountRemaining.textContent = remainingItems.length;
  if (els.summaryCountOverdue) els.summaryCountOverdue.textContent = overdue.length;
  if (els.summaryCountSoon) els.summaryCountSoon.textContent = dueSoon.length;
  if (els.summaryCountDone) els.summaryCountDone.textContent = doneCount;

  return { ...totals, daysInMonth };
}

function renderZeroState() {
  if (!els.zeroState) return;
  if (state.templates.length === 0 && isFirstRunCompleted()) {
    els.zeroState.classList.remove("hidden");
  } else {
    els.zeroState.classList.add("hidden");
  }
}

function validateLoadedState() {
  const ok =
    Array.isArray(state.templates) &&
    Array.isArray(state.instances) &&
    Array.isArray(state.payments) &&
    Array.isArray(state.funds);
  if (!ok) {
    return { ok: false, reason: "Loaded data is invalid. Entering safe mode." };
  }
  return { ok: true };
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
  if (els.markAllSoon) {
    els.markAllSoon.disabled = dueSoon.length === 0;
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
    amount.textContent = formatMoneyDisplay(item.amount_remaining);
    right.appendChild(amount);
    if (!state.readOnly) {
      const kebab = document.createElement("button");
      kebab.className = "ghost-btn small";
      kebab.textContent = "…";
      kebab.setAttribute("aria-label", "Open details");
      kebab.addEventListener("click", (event) => {
        event.stopPropagation();
        openInstanceDetail(item.id);
      });
      const logBtn = document.createElement("button");
      logBtn.className = "ghost-btn small";
      logBtn.textContent = "Log update";
      logBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openLogUpdateFor(item.id);
      });
      const action = document.createElement("button");
      action.className = "btn-small btn-primary";
      action.textContent = "Mark done";
      action.addEventListener("click", (event) => {
        event.stopPropagation();
        markPaid(item.id);
      });
      right.appendChild(kebab);
      right.appendChild(logBtn);
      right.appendChild(action);
    }

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
  recordMutation();
}

async function handleMarkFundPaid(fundId) {
  await postAction({
    type: "MARK_FUND_PAID",
    fund_id: fundId,
  });
  await refreshAll();
  recordMutation();
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
  const eventKey = JSON.stringify({
    period: `${state.selectedYear}-${pad2(state.selectedMonth)}`,
    essentialsOnly: state.essentialsOnly,
    events,
    provider: getActiveProviderName(),
    connected: isActiveMamdouConnected(),
  });
  if (
    state.lastNudgeKey === eventKey &&
    Date.now() - Number(state.lastNudgeAt || 0) < NUDGE_CACHE_TTL_MS
  ) {
    return;
  }
  if (!isActiveMamdouConnected()) {
    state.nudges = [];
    state.lastNudgeKey = eventKey;
    state.lastNudgeAt = Date.now();
    renderNudges();
    return;
  }
  const shouldProbe = events.length === 0 && !state.llmChecked;
  if (events.length === 0 && !shouldProbe) {
    state.nudges = [];
    state.lastNudgeKey = eventKey;
    state.lastNudgeAt = Date.now();
    renderNudges();
    return;
  }
  if (shouldProbe) {
    state.llmChecked = true;
  }
  if (state.nudgeInFlight) return;
  state.nudgeInFlight = true;
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
      state.lastNudgeKey = eventKey;
      state.lastNudgeAt = Date.now();
      renderNudges();
      return;
    }
    const data = await res.json();
    state.llmStatus = { status: "ok", auth_url: null, error: null };
    state.nudges = data?.data?.messages || fallbackNudges(events);
    state.lastNudgeKey = eventKey;
    state.lastNudgeAt = Date.now();
    renderNudges();
  } catch (err) {
    state.llmStatus = { status: "unavailable", auth_url: null, error: err.message || "Mamdou unavailable" };
    state.nudges = fallbackNudges(events);
    state.lastNudgeKey = eventKey;
    state.lastNudgeAt = Date.now();
    renderNudges();
  } finally {
    state.nudgeInFlight = false;
  }
}

function scheduleNudgeRefresh() {
  if (AJL_WEB_MODE || state.readOnly) return;
  const derived = deriveInstances();
  const base = getBaseInstances(derived);
  const totals = computeTotals(base);
  const today = getTodayDateString();
  const overdueCount = base.filter(
    (item) =>
      item.status_derived !== "skipped" &&
      Number(item.amount_remaining || 0) > 0 &&
      item.due_date < today
  ).length;
  const isFree = totals.required > 0 && totals.remaining === 0 && overdueCount === 0;
  const events = buildNudgeEvents(base, totals, isFree);
  fetchNudges(events).catch(() => {});
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

function getQueueTargets(kind) {
  const derived = deriveInstances();
  const base = getBaseInstances(derived);
  const today = getTodayDateString();
  const currentMonth = isCurrentMonth(state.selectedYear, state.selectedMonth);
  if (!currentMonth) return [];
  if (kind === "overdue") {
    return base.filter(
      (item) =>
        item.status_derived !== "skipped" &&
        Number(item.amount_remaining || 0) > 0 &&
        item.due_date < today
    );
  }
  const dueSoonDays = Number(state.settings.defaults?.dueSoonDays || 7);
  const soonCutoff = new Date();
  soonCutoff.setDate(soonCutoff.getDate() + Math.max(1, dueSoonDays));
  const soonCutoffString = `${soonCutoff.getFullYear()}-${pad2(soonCutoff.getMonth() + 1)}-${pad2(soonCutoff.getDate())}`;
  return base.filter(
    (item) =>
      item.status_derived !== "skipped" &&
      Number(item.amount_remaining || 0) > 0 &&
      item.due_date >= today &&
      item.due_date <= soonCutoffString
  );
}

async function markQueueItemsDone(kind, options = {}) {
  const list = getQueueTargets(kind);
  const label = kind === "overdue" ? "overdue" : "due-soon";
  if (list.length === 0) {
    return { ok: false, done: 0, total: 0, message: `No ${label} items.` };
  }
  if (options.confirm === true) {
    const preview = list.slice(0, 5).map((item) => item.name_snapshot).join(", ");
    const suffix = list.length > 5 ? "…" : "";
    const confirmed = window.confirm(
      `Mark ${list.length} ${label} item(s) done?\n${preview}${suffix}`
    );
    if (!confirmed) {
      return { ok: false, done: 0, total: list.length, message: "Canceled." };
    }
  }
  const ids = list.map((item) => item.id);
  const outcome = await markInstancesDone(ids);
  if (outcome.done > 0 && options.toast !== false) {
    showToast(`Marked ${outcome.done} ${label} item(s) done.`, "Undo", async () => {
      await markInstancesPending(ids);
    });
  }
  if (outcome.done === 0) {
    return {
      ok: false,
      done: 0,
      total: ids.length,
      message: outcome.failed?.[0]?.error || `Unable to mark ${label} items done.`,
    };
  }
  const failCount = Math.max(0, Number(outcome.total || 0) - Number(outcome.done || 0));
  const message =
    failCount > 0 ?
      `Marked ${outcome.done} ${label} item(s) done (${failCount} failed).` :
      `Marked ${outcome.done} ${label} item(s) done.`;
  return { ok: failCount === 0, done: outcome.done, total: outcome.total, message };
}

function resolveInstanceTargetsByNames(baseList, rawNames) {
  const names = splitTargetNames(rawNames);
  const ids = [];
  const seen = new Set();
  const unresolved = [];
  for (const name of names) {
    const resolved = findInstanceByName(name, baseList, { withMeta: true });
    if (resolved.match) {
      const id = String(resolved.match.id || "");
      if (id && !seen.has(id)) {
        ids.push(id);
        seen.add(id);
      }
      continue;
    }
    if (resolved.ambiguous) {
      unresolved.push(`ambiguous: ${name}`);
    } else {
      unresolved.push(name);
    }
  }
  return { ids, unresolved };
}

async function applyProposal(proposal) {
  if (!proposal) return { ok: false, message: "No action found." };
  const derived = deriveInstances();
  const base = getBaseInstances(derived);
  const targetName = proposal.target?.name || proposal.payload?.name || "";
  let instance = null;
  let template = null;
  let fund = null;
  let ambiguityMessage = null;

  if (proposal.target?.type === "instance") {
    const resolved = findInstanceByName(targetName, base, { withMeta: true });
    instance = resolved.match;
    if (!instance && resolved.ambiguous) {
      ambiguityMessage = formatAmbiguityMessage("bills", targetName, resolved.ambiguous);
    }
  } else if (proposal.target?.type === "template") {
    const resolved = findTemplateByName(targetName, { withMeta: true });
    template = resolved.match;
    if (!template && resolved.ambiguous) {
      ambiguityMessage = formatAmbiguityMessage("templates", targetName, resolved.ambiguous);
    }
  } else if (proposal.target?.type === "fund") {
    const resolved = findFundByName(targetName, { withMeta: true });
    fund = resolved.match;
    if (!fund && resolved.ambiguous) {
      ambiguityMessage = formatAmbiguityMessage("reserved buckets", targetName, resolved.ambiguous);
    }
  }

  const intent = String(proposal.intent || proposal.action || "").toUpperCase();

  if (!template && intent && intent.includes("TEMPLATE")) {
    const resolved = findTemplateByName(targetName, { withMeta: true });
    template = resolved.match;
    if (!template && resolved.ambiguous && !ambiguityMessage) {
      ambiguityMessage = formatAmbiguityMessage("templates", targetName, resolved.ambiguous);
    }
  }
  if (!fund && intent && (intent.includes("FUND") || intent.includes("SINKING"))) {
    const resolved = findFundByName(targetName, { withMeta: true });
    fund = resolved.match;
    if (!fund && resolved.ambiguous && !ambiguityMessage) {
      ambiguityMessage = formatAmbiguityMessage("reserved buckets", targetName, resolved.ambiguous);
    }
  }
  if (!instance && !template && !fund && targetName) {
    const resolved = findInstanceByName(targetName, base, { withMeta: true });
    instance = resolved.match;
    if (!instance && resolved.ambiguous && !ambiguityMessage) {
      ambiguityMessage = formatAmbiguityMessage("bills", targetName, resolved.ambiguous);
    }
  }

  if (intent === "UPDATE_AMOUNT_FLEX" && !instance) {
    const resolvedTemplate = findTemplateByName(targetName, { withMeta: true });
    template = resolvedTemplate.match || template;
    if (!template && resolvedTemplate.ambiguous && !ambiguityMessage) {
      ambiguityMessage = formatAmbiguityMessage("templates", targetName, resolvedTemplate.ambiguous);
    }
  }

  if (ambiguityMessage) {
    return { ok: false, message: ambiguityMessage };
  }

  if (intent === "UPDATE_AMOUNT_FLEX") {
    const amount = parseMoney(proposal.payload?.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, message: "Invalid amount." };
    }
    if (instance) {
      await postAction({
        type: "UPDATE_INSTANCE_FIELDS",
        instance_id: instance.id,
        amount,
      });
      await refreshAll();
      return { ok: true, message: "Updated this month bill amount." };
    }
    if (template) {
      await postAction({
        type: "UPDATE_TEMPLATE",
        template_id: template.id,
        amount_default: amount,
        year: state.selectedYear,
        month: state.selectedMonth,
      });
      await refreshAll();
      return { ok: true, message: "Updated template default amount." };
    }
    return { ok: false, message: "Could not find a matching bill or template." };
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
    } else if (intent === "SHOW_SHARE") {
      await openShareModal();
    } else if (intent === "SHOW_ASSISTANT") {
      els.assistantDrawer?.classList.remove("hidden");
    } else if (intent === "SHOW_SUMMARY" || intent === "SHOW_DASHBOARD") {
      state.view = "today";
      renderView();
      state.summaryExpanded = true;
      renderDashboard();
    } else {
      state.summaryExpanded = true;
      renderDashboard();
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
  if (
    intent === "LOCAL_SUMMARY_REMAINING" ||
    intent === "LOCAL_SUMMARY_OVERDUE" ||
    intent === "LOCAL_SUMMARY_DUE_SOON" ||
    intent === "LOCAL_SUMMARY_FREE"
  ) {
    const today = getTodayDateString();
    const list = getBaseInstances(deriveInstances());
    const totals = computeTotals(list);
    const currentMonth = isCurrentMonth(state.selectedYear, state.selectedMonth);
    const remainingItems = list.filter((item) => item.status_derived !== "skipped" && item.amount_remaining > 0);
    const overdue = remainingItems.filter((item) => currentMonth && item.due_date < today);
    const dueSoonDays = Number(state.settings.defaults?.dueSoonDays || 7);
    const soonCutoff = new Date();
    soonCutoff.setDate(soonCutoff.getDate() + Math.max(1, dueSoonDays));
    const soonCutoffString = `${soonCutoff.getFullYear()}-${pad2(soonCutoff.getMonth() + 1)}-${pad2(soonCutoff.getDate())}`;
    const dueSoon = remainingItems.filter(
      (item) => currentMonth && item.due_date >= today && item.due_date <= soonCutoffString
    );
    if (intent === "LOCAL_SUMMARY_REMAINING") {
      return { ok: true, message: `Remaining this month: ${formatMoney(totals.remaining)} (${remainingItems.length} bills).` };
    }
    if (intent === "LOCAL_SUMMARY_OVERDUE") {
      return { ok: true, message: `Overdue: ${overdue.length} bill(s).` };
    }
    if (intent === "LOCAL_SUMMARY_DUE_SOON") {
      return { ok: true, message: `Due soon (${dueSoonDays} days): ${dueSoon.length} bill(s).` };
    }
    if (totals.required > 0 && totals.remaining === 0 && overdue.length === 0) {
      return { ok: true, message: "Yes — free for the month." };
    }
    return { ok: true, message: "Not free yet for this month." };
  }
  if (intent === "START_AGENT_AUTH") {
    const result = await connectMamdouFlow(proposal.payload?.provider || "");
    if (result.ok) {
      els.assistantDrawer?.classList.remove("hidden");
      if (result.authUrl) {
        return { ok: true, message: result.message };
      }
      return { ok: true, message: result.message };
    }
    if (result.message && result.message.toLowerCase().includes("setup")) {
      openSetupAgentSection();
    }
    renderAssistantConnection();
    renderSetupAgentConnection();
    if (result.authUrl) {
      return { ok: true, message: result.message };
    }
    if (!result.ok) {
      return { ok: false, message: result.message || "Unable to connect Mamdou." };
    }
    els.assistantDrawer?.classList.remove("hidden");
    return { ok: true, message: result.message || "Mamdou connected." };
  }
  if (intent === "SHOW_SHARE") {
    await openShareModal();
    return { ok: true, message: "Opened share controls." };
  }
  if (intent === "COPY_SHARE") {
    if (!state.shareInfo?.url) {
      return { ok: false, message: "No active share link yet." };
    }
    await copyShareLink();
    return { ok: true, message: "Copied share link." };
  }
  if (intent === "CREATE_SHARE") {
    await openShareModal();
    await createShareLink();
    if (state.shareInfo?.url) {
      return { ok: true, message: "Created share link." };
    }
    return { ok: false, message: "Unable to create share link." };
  }
  if (intent === "REFRESH_SHARE") {
    if (!state.shareInfo?.token) return { ok: false, message: "No active share link yet." };
    await refreshSharedNow();
    return { ok: true, message: "Shared view updated." };
  }
  if (intent === "DISABLE_SHARE") {
    if (!state.shareInfo?.token) return { ok: false, message: "No active share link yet." };
    await disableShareLink({ skipConfirm: true });
    return { ok: true, message: "Share link disabled." };
  }
  if (intent === "REGENERATE_SHARE") {
    if (!state.shareInfo?.token) return { ok: false, message: "No active share link yet." };
    await regenerateShareLink({ skipConfirm: true });
    if (state.shareInfo?.url) return { ok: true, message: "Share link regenerated." };
    return { ok: false, message: "Unable to regenerate share link." };
  }
  if (intent === "MARK_ALL_OVERDUE") {
    const result = await markQueueItemsDone("overdue", { confirm: false, toast: false });
    return { ok: result.ok, message: result.message || "Unable to mark overdue items." };
  }
  if (intent === "MARK_ALL_DUE_SOON") {
    const result = await markQueueItemsDone("dueSoon", { confirm: false, toast: false });
    return { ok: result.ok, message: result.message || "Unable to mark due-soon items." };
  }
  if (intent === "MARK_INSTANCES_BULK_DONE") {
    const resolved = resolveInstanceTargetsByNames(base, proposal.payload?.names || []);
    if (resolved.ids.length === 0) {
      const unresolved = resolved.unresolved.length > 0 ? ` Unresolved: ${resolved.unresolved.slice(0, 5).join(", ")}.` : "";
      return { ok: false, message: `No matching bills found.${unresolved}` };
    }
    const result = await markInstancesDone(resolved.ids);
    const unresolvedLabel = resolved.unresolved.length > 0 ? ` Unresolved: ${resolved.unresolved.slice(0, 5).join(", ")}.` : "";
    if (result.done <= 0) {
      return { ok: false, message: `Unable to mark done.${unresolvedLabel}` };
    }
    const failCount = Math.max(0, Number(result.total || 0) - Number(result.done || 0));
    const failLabel = failCount > 0 ? ` (${failCount} failed)` : "";
    return { ok: failCount === 0, message: `Marked ${result.done} bill(s) done${failLabel}.${unresolvedLabel}` };
  }
  if (intent === "MARK_INSTANCES_BULK_PENDING") {
    const resolved = resolveInstanceTargetsByNames(base, proposal.payload?.names || []);
    if (resolved.ids.length === 0) {
      const unresolved = resolved.unresolved.length > 0 ? ` Unresolved: ${resolved.unresolved.slice(0, 5).join(", ")}.` : "";
      return { ok: false, message: `No matching bills found.${unresolved}` };
    }
    const result = await markInstancesPending(resolved.ids);
    const unresolvedLabel = resolved.unresolved.length > 0 ? ` Unresolved: ${resolved.unresolved.slice(0, 5).join(", ")}.` : "";
    if (result.done <= 0) {
      return { ok: false, message: `Unable to mark pending.${unresolvedLabel}` };
    }
    const failCount = Math.max(0, Number(result.total || 0) - Number(result.done || 0));
    const failLabel = failCount > 0 ? ` (${failCount} failed)` : "";
    return { ok: failCount === 0, message: `Marked ${result.done} bill(s) pending${failLabel}.${unresolvedLabel}` };
  }
  if (intent === "SKIP_INSTANCES_BULK") {
    const resolved = resolveInstanceTargetsByNames(base, proposal.payload?.names || []);
    if (resolved.ids.length === 0) {
      const unresolved = resolved.unresolved.length > 0 ? ` Unresolved: ${resolved.unresolved.slice(0, 5).join(", ")}.` : "";
      return { ok: false, message: `No matching bills found.${unresolved}` };
    }
    let skipped = 0;
    for (const id of resolved.ids) {
      const row = await postAction({ type: "SKIP_INSTANCE", instance_id: id });
      if (row?.ok && row.instance) {
        updateInstanceInState(row.instance);
        skipped += 1;
      }
    }
    if (skipped > 0) {
      await loadPayments();
      await loadActivityEvents();
      renderDashboard();
      recordMutation();
      scheduleSharePublish();
    }
    const unresolvedLabel = resolved.unresolved.length > 0 ? ` Unresolved: ${resolved.unresolved.slice(0, 5).join(", ")}.` : "";
    return {
      ok: skipped > 0,
      message: skipped > 0 ? `Skipped ${skipped} bill(s).${unresolvedLabel}` : `No bills skipped.${unresolvedLabel}`,
    };
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

  if (intent === "CREATE_TEMPLATES_BULK") {
    const templates = Array.isArray(proposal.payload?.templates) ? proposal.payload.templates : [];
    const outcome = await applyIntakeTemplates(templates);
    return { ok: outcome.created > 0, message: outcome.message };
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

  if (intent === "ARCHIVE_TEMPLATES_BULK") {
    const names = splitTargetNames(proposal.payload?.names || []);
    if (names.length === 0) return { ok: false, message: "No templates provided." };
    let archived = 0;
    const missed = [];
    for (const name of names) {
      const resolved = findTemplateByName(name, { withMeta: true });
      const match = resolved.match;
      if (!match) {
        if (resolved.ambiguous) {
          missed.push(`ambiguous: ${name}`);
          continue;
        }
        missed.push(name);
        continue;
      }
      const result = await postAction({ type: "ARCHIVE_TEMPLATE", template_id: match.id });
      if (result?.ok) archived += 1;
      else missed.push(name);
    }
    if (archived > 0) await refreshAll();
    const missedLabel = missed.length > 0 ? ` Unresolved: ${missed.slice(0, 5).join(", ")}.` : "";
    return {
      ok: archived > 0,
      message: archived > 0 ? `Archived ${archived} template(s).${missedLabel}` : `No templates archived.${missedLabel}`,
    };
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

  if (intent === "DELETE_TEMPLATES_BULK") {
    const names = splitTargetNames(proposal.payload?.names || []);
    if (names.length === 0) return { ok: false, message: "No templates provided." };
    let deleted = 0;
    const missed = [];
    for (const name of names) {
      const resolved = findTemplateByName(name, { withMeta: true });
      const match = resolved.match;
      if (!match) {
        if (resolved.ambiguous) {
          missed.push(`ambiguous: ${name}`);
          continue;
        }
        missed.push(name);
        continue;
      }
      const result = await postAction({
        type: "DELETE_TEMPLATE",
        template_id: match.id,
        year: state.selectedYear,
        month: state.selectedMonth,
      });
      if (result?.ok) deleted += 1;
      else missed.push(name);
    }
    if (deleted > 0) await refreshAll();
    const missedLabel = missed.length > 0 ? ` Unresolved: ${missed.slice(0, 5).join(", ")}.` : "";
    return {
      ok: deleted > 0,
      message: deleted > 0 ? `Deleted ${deleted} template(s).${missedLabel}` : `No templates deleted.${missedLabel}`,
    };
  }

  if (intent === "ACTIVATE_TEMPLATES_BULK") {
    const names = splitTargetNames(proposal.payload?.names || []);
    if (names.length === 0) return { ok: false, message: "No templates provided." };
    let updated = 0;
    const missed = [];
    for (const name of names) {
      const resolved = findTemplateByName(name, { withMeta: true });
      const match = resolved.match;
      if (!match) {
        if (resolved.ambiguous) {
          missed.push(`ambiguous: ${name}`);
          continue;
        }
        missed.push(name);
        continue;
      }
      const result = await postAction({
        type: "UPDATE_TEMPLATE",
        template_id: match.id,
        active: true,
        year: state.selectedYear,
        month: state.selectedMonth,
      });
      if (result?.ok) updated += 1;
      else missed.push(name);
    }
    if (updated > 0) await refreshAll();
    const missedLabel = missed.length > 0 ? ` Unresolved: ${missed.slice(0, 5).join(", ")}.` : "";
    return {
      ok: updated > 0,
      message: updated > 0 ? `Activated ${updated} template(s).${missedLabel}` : `No templates activated.${missedLabel}`,
    };
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

async function sendLlmAgent(source = "drawer") {
  if (!els.llmAgentInput || !els.llmAgentOutput) return;
  const inputEl = source === "inline" ? els.agentInlineInput : els.llmAgentInput;
  const fallbackInput = source === "inline" ? els.llmAgentInput : els.agentInlineInput;
  if (!inputEl) return;
  if (AJL_WEB_MODE) {
    setAgentStatus("Mamdou is available in the local app only.");
    pushLlmMessage("assistant", "Mamdou is available in the local app only.");
    return;
  }
  if (state.qwenAuth && state.qwenAuth.status === "disabled") {
    setAgentStatus("Mamdou is available in the local app only.");
    pushLlmMessage("assistant", "Mamdou is disabled in this build.");
    return;
  }
  const activeConnection = getActiveMamdouConnectionState();
  if (!activeConnection.connected) {
    const label = activeConnection.label || "provider";
    const guidance =
      activeConnection.provider === "qwen-oauth"
        ? "Use Connect Mamdou to start Qwen login."
        : `Connect ${label} in Setup or paste key in the Mamdou drawer.`;
    const message = `Connect Mamdou first (${label}). ${guidance}`;
    setAgentStatus(message);
    pushLlmMessage("assistant", message);
    return;
  }
  if (state.pendingAgentAction) {
    setAgentStatus("Confirm or cancel the pending action first.");
    return;
  }
  if (state.agentBusy) return;
  let text = String(inputEl.value || "").trim();
  if (!text && fallbackInput) {
    text = String(fallbackInput.value || "").trim();
  }
  if (!text) return;
  const normalized = text.toLowerCase();
  const nowTs = Date.now();
  if (
    normalized === state.lastAgentInput &&
    nowTs - Number(state.lastAgentSubmittedAt || 0) < AGENT_DUPLICATE_WINDOW_MS
  ) {
    setAgentStatus("Duplicate command ignored.");
    return;
  }
  state.lastAgentInput = normalized;
  state.lastAgentSubmittedAt = nowTs;

  setAgentBusy(true);
  setAgentStatus("Thinking...");
  pushLlmMessage("user", text);
  inputEl.value = "";
  focusAgentInput();
  const startedAt = performance.now();

  const fastProposal = parseFastCommand(text);
  if (fastProposal) {
    const summary = summarizeProposal(fastProposal);
    if (canAutoExecuteProposal(fastProposal)) {
      const outcome = await applyProposal(fastProposal);
      await logAutoAgentExecution(text, summary, fastProposal, outcome, { fast_path: true });
      setAgentStatus(`Done in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
      pushLlmMessage("assistant", outcome.message);
      setAgentBusy(false);
      return;
    }
    setPendingAgentAction({
      kind: "command",
      proposal: fastProposal,
      summary,
      source_text: text,
      fast_path: true,
    });
    setAgentStatus(`${summary}. Confirm to proceed.`);
    pushLlmMessage("assistant", `${summary}. Waiting for confirmation.`);
    setAgentBusy(false);
    return;
  }

  try {
    const res = await fetch("/internal/advisor/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "agent",
        payload: buildAgentPayload(text),
      }),
    });
    const requestId = getRequestIdFromResponse(res);
    const data = await res.json();
    if (!res.ok || !data?.ok) {
      const serverError = data?.error || "Mamdou unavailable";
      const displayError = requestId ? `${serverError} (ref: ${requestId})` : serverError;
      if (data?.auth_url) {
        state.llmStatus = { status: "auth_required", auth_url: data.auth_url, error: displayError };
      } else {
        state.llmStatus = { status: "unavailable", auth_url: null, error: displayError };
      }
      renderNudges();
      setAgentStatus(displayError);
      pushLlmMessage("assistant", "Mamdou unavailable.", displayError);
      return;
    }
    const doneStatus = (cached) =>
      `Done in ${((performance.now() - startedAt) / 1000).toFixed(1)}s${cached ? " (cached)" : ""}`;

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
      setAgentStatus(doneStatus(!!data?.cached));
      pushLlmMessage("assistant", answer);
      focusAgentInput();
      return;
    }

    if (kind === "command" || proposals.length > 0 || result.proposal) {
      const proposal = pickProposal();
      if (proposal?.clarifying_question) {
        setAgentStatus(`Need clarification (${((performance.now() - startedAt) / 1000).toFixed(1)}s)`);
        pushLlmMessage("assistant", proposal.clarifying_question);
        focusAgentInput();
        return;
      }
      if (canAutoExecuteProposal(proposal)) {
        const outcome = await applyProposal(proposal);
        await logAutoAgentExecution(text, summarizeProposal(proposal), proposal, outcome, {
          fast_path: false,
          cached: !!data?.cached,
        });
        setAgentStatus(doneStatus(!!data?.cached));
        pushLlmMessage("assistant", outcome.message);
        focusAgentInput();
        return;
      }
      const summary = summarizeProposal(proposal);
      setPendingAgentAction({ kind: "command", proposal, summary, source_text: text });
      setAgentStatus(`${summary}. Confirm to proceed.`);
      pushLlmMessage("assistant", `${summary}. Waiting for confirmation.`);
      focusAgentInput();
      return;
    }

    if (kind === "intake" || Array.isArray(result.templates)) {
      const questions = result.questions || [];
      const warnings = result.warnings || [];
      if (questions.length > 0) {
        const questionText = questions.map((q) => q.question).join(" ");
        setAgentStatus(`Need clarification (${((performance.now() - startedAt) / 1000).toFixed(1)}s)`);
        pushLlmMessage("assistant", questionText || "Need more details.");
        focusAgentInput();
        return;
      }
      const templates = result.templates || [];
      const summary = summarizeIntake(templates);
      setPendingAgentAction({ kind: "intake", templates, warnings, summary, source_text: text });
      const warningText = warnings.length > 0 ? warnings.join(" ") : "";
      setAgentStatus(`${summary}. Confirm to proceed.`);
      pushLlmMessage("assistant", `${summary}. Waiting for confirmation.`);
      if (warningText) {
        pushLlmMessage("assistant", warningText);
      }
      focusAgentInput();
      return;
    }

    const errors = Array.isArray(result.errors) ? result.errors : [];
    if (errors.length > 0) {
      setAgentStatus(`Completed with warnings (${((performance.now() - startedAt) / 1000).toFixed(1)}s${data?.cached ? ", cached" : ""})`);
      pushLlmMessage("assistant", errors.join(" "));
      focusAgentInput();
      return;
    }
    if (result.answer) {
      setAgentStatus(doneStatus(!!data?.cached));
      pushLlmMessage("assistant", result.answer);
      focusAgentInput();
      return;
    }
    setAgentStatus(doneStatus(!!data?.cached));
    pushLlmMessage("assistant", "No response.");
    focusAgentInput();
  } catch (err) {
    setAgentStatus("Mamdou unavailable.");
    pushLlmMessage("assistant", "Mamdou unavailable.");
    focusAgentInput();
  } finally {
    setAgentBusy(false);
  }
}

async function confirmPendingAgentAction() {
  const pending = state.pendingAgentAction;
  if (!pending) return;
  setAgentStatus("Applying...");
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
  setAgentStatus("");
  pushLlmMessage("assistant", outcome.message, pending.summary || "");
  clearPendingAgentAction();
  focusAgentInput();
}

function cancelPendingAgentAction() {
  if (!state.pendingAgentAction) return;
  clearPendingAgentAction();
  setAgentStatus("");
  pushLlmMessage("assistant", "Canceled.");
  focusAgentInput();
}

function resolveByName(name, list, getName) {
  const target = normalizeQuickTarget(name).toLowerCase();
  if (!target) return { match: null, ambiguous: null };
  const entries = Array.isArray(list) ? list : [];
  const withNames = entries
    .map((item) => ({ item, name: String(getName(item) || "").trim() }))
    .filter((entry) => entry.name.length > 0);
  const exact = withNames.filter((entry) => entry.name.toLowerCase() === target);
  if (exact.length === 1) {
    return { match: exact[0].item, ambiguous: null };
  }
  if (exact.length > 1) {
    return {
      match: null,
      ambiguous: exact.map((entry) => entry.name),
    };
  }
  const partial = withNames.filter((entry) => entry.name.toLowerCase().includes(target));
  if (partial.length === 1) {
    return { match: partial[0].item, ambiguous: null };
  }
  if (partial.length > 1) {
    return {
      match: null,
      ambiguous: partial.map((entry) => entry.name),
    };
  }
  return { match: null, ambiguous: null };
}

function formatAmbiguityMessage(kind, target, candidates) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (list.length === 0) return null;
  const preview = list.slice(0, 5).join(", ");
  const suffix = list.length > 5 ? ", …" : "";
  return `Multiple ${kind} match "${target}": ${preview}${suffix}. Be more specific.`;
}

function findInstanceByName(name, baseList, options = {}) {
  const resolved = resolveByName(name, baseList || [], (item) => item.name_snapshot);
  if (options.withMeta) return resolved;
  return resolved.match;
}

function findTemplateByName(name, options = {}) {
  const resolved = resolveByName(name, state.templates || [], (item) => item.name);
  if (options.withMeta) return resolved;
  return resolved.match;
}

function findFundByName(name, options = {}) {
  const resolved = resolveByName(name, state.funds || [], (item) => item.name);
  if (options.withMeta) return resolved;
  return resolved.match;
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

function setAgentStatus(text) {
  const message = String(text || "");
  if (els.llmAgentOutput) els.llmAgentOutput.textContent = message;
  if (els.agentInlineStatus) els.agentInlineStatus.textContent = message;
}

function setAgentBusy(busy) {
  const next = !!busy;
  state.agentBusy = next;
  if (els.llmAgentSend) els.llmAgentSend.disabled = next;
  if (els.agentInlineSend) els.agentInlineSend.disabled = next;
  if (els.llmAgentInput) els.llmAgentInput.disabled = next;
  if (els.agentInlineInput) els.agentInlineInput.disabled = next;
}

function setPendingAgentAction(action) {
  state.pendingAgentAction = action;
  if (els.llmAgentActions) els.llmAgentActions.classList.remove("hidden");
  if (els.agentInlineActions) els.agentInlineActions.classList.remove("hidden");
}

function clearPendingAgentAction() {
  state.pendingAgentAction = null;
  if (els.llmAgentActions) els.llmAgentActions.classList.add("hidden");
  if (els.agentInlineActions) els.agentInlineActions.classList.add("hidden");
}

function summarizeProposal(proposal) {
  if (!proposal) return "No proposal.";
  const intent = String(proposal.intent || proposal.action || "UNKNOWN").toUpperCase();
  const target = proposal.target?.name || proposal.payload?.name || "Unknown";
  if (intent === "MARK_PAID") return `Mark done: ${target}`;
  if (intent === "SKIP_INSTANCE") return `Skip: ${target}`;
  if (intent === "MARK_PENDING") return `Mark pending: ${target}`;
  if (intent === "MARK_INSTANCES_BULK_DONE") {
    const count = splitTargetNames(proposal.payload?.names || []).length;
    return count > 0 ? `Mark done ${count} bills` : "Mark multiple bills done";
  }
  if (intent === "MARK_INSTANCES_BULK_PENDING") {
    const count = splitTargetNames(proposal.payload?.names || []).length;
    return count > 0 ? `Mark pending ${count} bills` : "Mark multiple bills pending";
  }
  if (intent === "SKIP_INSTANCES_BULK") {
    const count = splitTargetNames(proposal.payload?.names || []).length;
    return count > 0 ? `Skip ${count} bills` : "Skip multiple bills";
  }
  if (intent === "ADD_PAYMENT") {
    const mode = proposal.payload?.amount_mode || "FIXED";
    if (mode === "FULL_REMAINING") return `Mark done: ${target}`;
    if (mode === "FRACTION") return `Log ${proposal.payload?.fraction || 0} progress: ${target}`;
    return `Log update for ${target}`;
  }
  if (intent === "UPDATE_INSTANCE_FIELDS") return `Update bill: ${target}`;
  if (intent === "UPDATE_AMOUNT_FLEX") return `Update amount: ${target}`;
  if (intent === "CREATE_TEMPLATE") return `Create template: ${target}`;
  if (intent === "CREATE_TEMPLATES_BULK") {
    const count = Array.isArray(proposal.payload?.templates) ? proposal.payload.templates.length : 0;
    return count > 0 ? `Create ${count} template(s)` : "Create templates";
  }
  if (intent === "UPDATE_TEMPLATE") return `Update template: ${target}`;
  if (intent === "ARCHIVE_TEMPLATE") return `Archive template: ${target}`;
  if (intent === "ARCHIVE_TEMPLATES_BULK") {
    const count = splitTargetNames(proposal.payload?.names || []).length;
    return count > 0 ? `Archive ${count} template(s)` : "Archive templates";
  }
  if (intent === "DELETE_TEMPLATE") return `Delete template: ${target}`;
  if (intent === "DELETE_TEMPLATES_BULK") {
    const count = splitTargetNames(proposal.payload?.names || []).length;
    return count > 0 ? `Delete ${count} template(s)` : "Delete templates";
  }
  if (intent === "ACTIVATE_TEMPLATES_BULK") {
    const count = splitTargetNames(proposal.payload?.names || []).length;
    return count > 0 ? `Activate ${count} template(s)` : "Activate templates";
  }
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
  if (intent === "MARK_ALL_OVERDUE") {
    const count = getQueueTargets("overdue").length;
    return count > 0 ? `Mark all overdue items done (${count})` : "Mark all overdue items done";
  }
  if (intent === "MARK_ALL_DUE_SOON") {
    const count = getQueueTargets("dueSoon").length;
    return count > 0 ? `Mark all due-soon items done (${count})` : "Mark all due-soon items done";
  }
  if (intent === "UNDO_PAYMENT") return `Undo update: ${target}`;
  if (intent === "SET_MONTH") return "Switch month";
  if (intent === "SET_ESSENTIALS_ONLY") return "Toggle essentials only";
  if (intent === "SHOW_SUMMARY") return "Show Today";
  if (intent === "SHOW_SHARE") return "Open share controls";
  if (intent === "CREATE_SHARE") return "Create share link";
  if (intent === "REFRESH_SHARE") return "Refresh shared view";
  if (intent === "DISABLE_SHARE") return "Disable share link";
  if (intent === "REGENERATE_SHARE") return "Regenerate share link";
  if (intent === "COPY_SHARE") return "Copy share link";
  if (intent === "SHOW_ASSISTANT") return "Open Mamdou";
  if (intent === "START_AGENT_AUTH") {
    const provider = normalizeMamdouProviderInput(proposal.payload?.provider || "");
    if (provider === "openai") return "Connect Mamdou with OpenAI";
    if (provider === "anthropic") return "Connect Mamdou with Anthropic";
    if (provider === "qwen-oauth") return "Start Mamdou Qwen login";
    return "Start Mamdou login";
  }
  if (intent === "LOCAL_SUMMARY_REMAINING") return "Show remaining this month";
  if (intent === "LOCAL_SUMMARY_OVERDUE") return "Show overdue count";
  if (intent === "LOCAL_SUMMARY_DUE_SOON") return "Show due-soon count";
  if (intent === "LOCAL_SUMMARY_FREE") return "Check free-for-month status";
  return `Intent: ${intent}`;
}

const AUTO_EXECUTE_INTENTS = new Set([
  "SHOW_DUE_SOON",
  "SHOW_OVERDUE",
  "SHOW_TEMPLATES",
  "SHOW_SUMMARY",
  "SHOW_DASHBOARD",
  "SHOW_BACKUP",
  "SHOW_PIGGY",
  "SHOW_SHARE",
  "SHOW_ASSISTANT",
  "COPY_SHARE",
  "START_AGENT_AUTH",
  "EXPORT_MONTH",
  "EXPORT_BACKUP",
  "LOCAL_SUMMARY_REMAINING",
  "LOCAL_SUMMARY_OVERDUE",
  "LOCAL_SUMMARY_DUE_SOON",
  "LOCAL_SUMMARY_FREE",
]);

function canAutoExecuteProposal(proposal) {
  if (!proposal) return false;
  const intent = String(proposal.intent || proposal.action || "").toUpperCase();
  if (!intent) return false;
  if (AUTO_EXECUTE_INTENTS.has(intent)) return true;
  return proposal.needs_confirmation === false && intent.startsWith("SHOW_");
}

function renderAssistantConnection() {
  if (!els.assistantConnection || !els.assistantConnectionTitle || !els.assistantConnectionBody || !els.assistantConnectionAction) {
    renderSetupAgentConnection();
    return;
  }
  if (els.assistantProviderConnect) {
    els.assistantProviderConnect.disabled = false;
  }
  if (els.assistantProviderSelect) {
    els.assistantProviderSelect.disabled = false;
  }
  if (els.assistantProviderSetup) {
    els.assistantProviderSetup.disabled = false;
  }
  if (AJL_WEB_MODE) {
    els.assistantConnectionTitle.textContent = "Mamdou unavailable";
    els.assistantConnectionBody.textContent = "Mamdou is available in the local app only.";
    els.assistantConnectionAction.innerHTML = "";
    if (els.assistantProviderHint) {
      els.assistantProviderHint.textContent = "Local-only feature.";
    }
    if (els.assistantProviderConnect) {
      els.assistantProviderConnect.disabled = true;
    }
    if (els.assistantProviderSelect) {
      els.assistantProviderSelect.disabled = true;
    }
    if (els.assistantProviderSetup) {
      els.assistantProviderSetup.disabled = true;
    }
    if (els.assistantProviderKeyRow) {
      els.assistantProviderKeyRow.classList.add("hidden");
    }
    if (els.agentInlineConnection) {
      els.agentInlineConnection.textContent = "Mamdou unavailable on web.";
    }
    renderSetupAgentConnection();
    return;
  }
  const actionWrap = els.assistantConnectionAction;
  actionWrap.innerHTML = "";
  const activeProvider = getActiveProviderName();
  const connection = getProviderConnectionState(activeProvider);
  const selectedProvider =
    normalizeMamdouProviderInput(els.assistantProviderSelect?.value || "") || activeProvider;
  const selectedState = getProviderConnectionState(selectedProvider);

  if (els.assistantProviderSelect) {
    if (!normalizeMamdouProviderInput(els.assistantProviderSelect.value || "")) {
      els.assistantProviderSelect.value = activeProvider;
    }
  }
  if (els.assistantProviderKeyRow) {
    const showKey = selectedProvider !== "qwen-oauth";
    els.assistantProviderKeyRow.classList.toggle("hidden", !showKey);
  }
  if (els.assistantProviderKey) {
    if (selectedProvider === "openai") {
      els.assistantProviderKey.placeholder = selectedState.configured
        ? "Optional: replace OpenAI API key (saved locally, encrypted)"
        : "Paste OpenAI API key (saved locally, encrypted)";
    } else if (selectedProvider === "anthropic") {
      els.assistantProviderKey.placeholder = selectedState.configured
        ? "Optional: replace Anthropic API key (saved locally, encrypted)"
        : "Paste Anthropic API key (saved locally, encrypted)";
    } else {
      els.assistantProviderKey.placeholder = "Paste provider API key (saved locally, encrypted)";
      els.assistantProviderKey.value = "";
    }
  }

  let title = "Connect Mamdou";
  let body = "Use Mamdou login to enable insights.";
  let action = null;

  if (state.qwenAuth?.status === "disabled") {
    title = "Mamdou unavailable";
    body = "Use the local app to connect Mamdou.";
  } else if (connection.connected) {
    title = "Agent connected";
    body = `Mamdou is ready via ${connection.label}.`;
  } else if (connection.provider === "qwen-oauth" && connection.pending && connection.authUrl) {
    title = "Authorize Mamdou";
    body = "Authorize in browser, then return here.";
    action = { type: "link", label: "Open login", href: connection.authUrl };
  } else if (connection.provider === "qwen-oauth" && state.llmStatus?.status === "auth_required" && connection.authUrl) {
    title = "Mamdou login required";
    body = "Complete device authorization.";
    action = { type: "link", label: "Complete login", href: connection.authUrl };
  } else if (connection.provider === "qwen-oauth" && state.qwenAuth?.status === "expired") {
    title = "Login expired";
    body = "Start Mamdou login again.";
    action = { type: "button", label: "Start login", onClick: startQwenAuth };
  } else if (connection.provider === "qwen-oauth" && state.qwenAuth?.status === "error") {
    title = "Mamdou error";
    body = connection.lastError || "Unable to start Mamdou auth.";
    action = { type: "button", label: "Retry", onClick: startQwenAuth };
  } else if (connection.provider !== "qwen-oauth" && !connection.configured) {
    title = "Connect Mamdou";
    body = `Add your ${connection.label} API key in Setup.`;
    action = { type: "button", label: "Open Setup", onClick: openSetupAgentSection };
  } else if (connection.provider !== "qwen-oauth" && connection.lastError) {
    title = "Mamdou error";
    body = connection.lastError;
    action = { type: "button", label: "Open Setup", onClick: openSetupAgentSection };
  } else if (connection.provider !== "qwen-oauth") {
    title = "Connect Mamdou";
    body = `Activate ${connection.label} in Setup to continue.`;
    action = { type: "button", label: "Open Setup", onClick: openSetupAgentSection };
  } else if (!connection.connected) {
    action = { type: "button", label: "Start login", onClick: startQwenAuth };
  }

  els.assistantConnectionTitle.textContent = title;
  els.assistantConnectionBody.textContent = body;
  if (els.agentInlineConnection) {
    els.agentInlineConnection.textContent = connection.connected ? "Connected and ready for commands." : body;
  }
  if (els.assistantProviderHint) {
    if (selectedProvider === activeProvider) {
      if (connection.connected) {
        els.assistantProviderHint.textContent = `Active provider: ${connection.label}.`;
      } else if (connection.provider === "qwen-oauth" && connection.pending) {
        els.assistantProviderHint.textContent = "Qwen authorization pending.";
      } else if (connection.provider !== "qwen-oauth" && !connection.configured) {
        els.assistantProviderHint.textContent = `${connection.label} key not configured yet. Paste key and connect, or open Setup.`;
      } else if (connection.lastError) {
        els.assistantProviderHint.textContent = connection.lastError;
      } else {
        els.assistantProviderHint.textContent = "Connect Mamdou to enable commands.";
      }
    } else if (selectedProvider !== "qwen-oauth" && !selectedState.configured) {
      els.assistantProviderHint.textContent = `${selectedState.label} key not configured. Paste key here or open Setup.`;
    } else if (selectedProvider !== "qwen-oauth" && selectedState.configured) {
      els.assistantProviderHint.textContent = `${selectedState.label} is ready. Click Connect Mamdou to switch provider.`;
    } else {
      els.assistantProviderHint.textContent = `Selected provider: ${selectedState.label}. Click Connect Mamdou to switch.`;
    }
  }

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
  if (els.assistantProviderConnect) {
    const hasInlineKey = String(els.assistantProviderKey?.value || "").trim().length > 0;
    const needsKey = selectedProvider !== "qwen-oauth" && !selectedState.configured && !hasInlineKey;
    els.assistantProviderConnect.disabled = needsKey;
    if (selectedProvider === "qwen-oauth") {
      els.assistantProviderConnect.textContent = connection.connected ? "Reconnect Qwen" : "Connect Mamdou";
    } else {
      els.assistantProviderConnect.textContent = hasInlineKey
        ? `Save key & connect ${selectedState.label}`
        : `Connect ${selectedState.label}`;
    }
  }
  renderSetupAgentConnection();
}

function renderSetupAgentConnection() {
  if (
    AJL_WEB_MODE ||
    !els.setupAgentStatus ||
    !els.setupAgentProvider ||
    !els.setupAgentModel ||
    !els.setupAgentKeyRow ||
    !els.setupAgentBaseRow ||
    !els.setupAgentConnectKey ||
    !els.setupAgentStart ||
    !els.setupAgentOpen ||
    !els.setupAgentSaveProvider ||
    !els.setupAgentTest ||
    !els.setupAgentRefresh ||
    !els.setupAgentDisconnect
  ) {
    return;
  }
  const selectedProvider = String(els.setupAgentProvider.value || "qwen-oauth").toLowerCase();
  const activeProvider = String(state.llmProviders?.active_provider || "qwen-oauth").toLowerCase();
  const connection = getProviderConnectionState(selectedProvider);
  const isActive = selectedProvider === activeProvider;
  const selectedIsQwen = selectedProvider === "qwen-oauth";

  els.setupAgentKeyRow.classList.toggle("hidden", selectedIsQwen);
  els.setupAgentBaseRow.classList.toggle("hidden", selectedIsQwen);
  els.setupAgentConnectKey.classList.toggle("hidden", selectedIsQwen);
  els.setupAgentStart.classList.add("hidden");
  els.setupAgentOpen.classList.add("hidden");
  els.setupAgentDisconnect.classList.add("hidden");
  els.setupAgentSaveProvider.classList.remove("hidden");
  els.setupAgentTest.classList.remove("hidden");
  els.setupAgentRefresh.disabled = false;
  els.setupAgentSaveProvider.disabled = false;
  els.setupAgentTest.disabled = false;
  els.setupAgentConnectKey.disabled = false;

  if (state.qwenAuth?.status === "disabled") {
    els.setupAgentStatus.textContent = "Mamdou is unavailable in this build.";
    return;
  }
  if (!els.setupAgentModel.value.trim()) {
    els.setupAgentModel.value = String(connection.model || defaultModelForProvider(selectedProvider));
  }
  if (!selectedIsQwen && !els.setupAgentBase.value.trim() && connection.baseUrl) {
    els.setupAgentBase.value = connection.baseUrl;
  }

  if (!isActive) {
    if (selectedIsQwen && !connection.connected) {
      els.setupAgentStatus.textContent = 'Selected provider: qwen-oauth. Click "Set provider", then "Start login".';
    } else if (!selectedIsQwen && !connection.configured) {
      els.setupAgentStatus.textContent = `Selected provider: ${selectedProvider}. Enter API key, click "Connect key", then "Set provider".`;
    } else {
      els.setupAgentStatus.textContent = `Selected provider: ${selectedProvider}. Click "Set provider" to activate it.`;
    }
  } else if (connection.connected) {
    els.setupAgentStatus.textContent = `Agent connected via ${providerDisplayName(selectedProvider)}. Mamdou is ready.`;
    els.setupAgentDisconnect.classList.remove("hidden");
  } else if (selectedIsQwen && connection.pending) {
    els.setupAgentStatus.textContent = "Qwen authorization pending. Complete login in browser, then refresh.";
  } else if (!selectedIsQwen && !connection.configured) {
    els.setupAgentStatus.textContent = `Enter ${selectedProvider} API key and click "Connect key".`;
  } else if (selectedIsQwen && state.qwenAuth?.status === "expired") {
    els.setupAgentStatus.textContent = "Login expired. Start Mamdou login again.";
  } else if (selectedIsQwen && state.qwenAuth?.status === "error") {
    els.setupAgentStatus.textContent = connection.lastError || "Unable to connect Mamdou right now.";
  } else if (!selectedIsQwen && connection.lastError) {
    els.setupAgentStatus.textContent = connection.lastError;
  } else if (!connection.connected) {
    els.setupAgentStatus.textContent = "Connect Mamdou to enable agent commands.";
  }

  if (selectedIsQwen) {
    if (connection.connected) {
      els.setupAgentDisconnect.classList.remove("hidden");
      return;
    }
    if (connection.pending && connection.authUrl) {
      els.setupAgentOpen.href = connection.authUrl;
      els.setupAgentOpen.classList.remove("hidden");
      els.setupAgentStart.classList.remove("hidden");
      return;
    }
    els.setupAgentStart.classList.remove("hidden");
    return;
  }

  if (connection.connected || connection.configured) {
    els.setupAgentDisconnect.classList.remove("hidden");
  }
}


function renderNudges() {
  renderAssistantConnection();
  if (!els.nudgesList) return;
  els.nudgesList.innerHTML = "";
  let hasStatusRow = false;

  const activeProvider = getActiveProviderName();
  const connection = getProviderConnectionState(activeProvider);

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
  } else if (!connection.connected) {
    const row = document.createElement("div");
    row.className = "list-item";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = `Connect Mamdou (${connection.label})`;
    const body = document.createElement("div");
    body.className = "meta";
    if (connection.provider === "qwen-oauth" && connection.pending && connection.authUrl) {
      body.textContent = "Authorize in browser, then return here.";
    } else if (connection.provider === "qwen-oauth" && state.qwenAuth.status === "error") {
      body.textContent = connection.lastError || "Unable to start Mamdou auth.";
    } else if (connection.provider === "qwen-oauth" && state.qwenAuth.status === "expired") {
      body.textContent = "Login expired. Start again.";
    } else if (connection.provider !== "qwen-oauth" && !connection.configured) {
      body.textContent = `Add your ${connection.label} API key in Setup.`;
    } else {
      body.textContent = "Use Setup to finish Mamdou connection.";
    }
    left.appendChild(title);
    left.appendChild(body);

    if (connection.provider === "qwen-oauth" && connection.authUrl) {
      const link = document.createElement("a");
      link.className = "btn-small";
      link.href = connection.authUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open login";
      row.appendChild(left);
      row.appendChild(link);
    } else if (connection.provider === "qwen-oauth") {
      const action = document.createElement("button");
      action.className = "btn-small";
      action.textContent = "Start login";
      action.addEventListener("click", () => startQwenAuth());
      row.appendChild(left);
      row.appendChild(action);
    } else {
      const action = document.createElement("button");
      action.className = "btn-small";
      action.textContent = "Open Setup";
      action.addEventListener("click", () => openSetupAgentSection());
      row.appendChild(left);
      row.appendChild(action);
    }
    els.nudgesList.appendChild(row);
    hasStatusRow = true;
  } else {
    const row = document.createElement("div");
    row.className = "list-item";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = `Mamdou ready (${connection.label}).`;
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
    state.summaryExpanded = true;
    renderDashboard();
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

function renderImportPreview() {
  if (!els.importPreview || !els.importSummary) return;
  const pending = state.pendingImport;
  if (!pending) {
    els.importPreview.classList.add("hidden");
    if (els.importConfirm) {
      els.importConfirm.disabled = true;
    }
    return;
  }
  const summary = pending.summary;
  els.importPreview.classList.remove("hidden");
  const range = summary.range ? `${summary.range.start} → ${summary.range.end}` : "—";
  const exportedAt = summary.exported_at ? formatDateTime(summary.exported_at) : "Unknown";
  els.importSummary.innerHTML = `
    <div><strong>Templates:</strong> ${summary.templates}</div>
    <div><strong>Items:</strong> ${summary.instances}</div>
    <div><strong>Updates:</strong> ${summary.payments}</div>
    <div><strong>Period:</strong> ${range}</div>
    <div><strong>Exported:</strong> ${exportedAt}</div>
  `;
  if (els.importConflicts) {
    if (pending.mode === "merge" && pending.conflicts > 0) {
      els.importConflicts.textContent = `Conflicts detected: ${pending.conflicts}. Existing items will be kept.`;
    } else {
      els.importConflicts.textContent = "";
    }
  }
  if (els.importConfirm) {
    els.importConfirm.disabled = false;
  }
}

function getShareTokenFromPath() {
  const queryToken = new URLSearchParams(window.location.search).get("share");
  if (queryToken && /^[A-Za-z0-9_-]{24,128}$/.test(queryToken)) {
    return queryToken;
  }
  const match = window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]{24,128})\/?$/);
  return match ? match[1] : null;
}

function setReadOnlyMode(enabled) {
  state.readOnly = enabled;
  if (enabled) {
    sharePublishDirty = false;
    sharePublishRetryCount = 0;
    clearSharePublishTimers();
  }
  if (!enabled) {
    state.sharePrivacy = null;
    state.sharedMeta = null;
    state.sharedEtag = "";
    stopSharedLivePolling();
  }
  document.body.classList.toggle("read-only", enabled);
  if (enabled && els.sharedHeader) {
    els.sharedHeader.classList.remove("hidden");
    els.sharedHeader.classList.add("visible");
  }
  if (!enabled && els.sharedHeader) {
    els.sharedHeader.classList.add("hidden");
    els.sharedHeader.classList.remove("visible");
  }
}

function renderSharedHeader(label, meta = {}) {
  if (!els.sharedHeader) return;
  if (els.sharedOwner) {
    if (label) {
      els.sharedOwner.textContent = label;
    } else if (meta.ownerLabel) {
      els.sharedOwner.textContent = meta.ownerLabel;
    } else {
      els.sharedOwner.textContent = "Read-only shared view";
    }
  }
  if (els.sharedUpdated) {
    const updatedRaw = meta.lastPublishedAt || meta.last_published_at || null;
    const expiresRaw = meta.expiresAt || meta.expires_at || null;
    const parts = [];
    if (updatedRaw) parts.push(`Updated ${formatDateTime(updatedRaw)}`);
    if (expiresRaw) parts.push(`Expires ${formatDateTime(expiresRaw)}`);
    els.sharedUpdated.textContent = parts.join(" · ");
  }
  els.sharedHeader.classList.remove("hidden");
  els.sharedHeader.classList.add("visible");
}

function stopSharedLivePolling() {
  if (sharedLiveTimer) {
    clearInterval(sharedLiveTimer);
    sharedLiveTimer = null;
  }
}

function startSharedLivePolling(token, mode) {
  stopSharedLivePolling();
  if (!state.readOnly) return;
  if (!token || mode !== "live") return;
  sharedLiveTimer = setInterval(() => {
    if (document.hidden) return;
    loadSharedView(token, { silent: true }).catch(() => {});
  }, SHARE_LIVE_REFRESH_MS);
}

async function refreshShareRelayStatus() {
  if (!els.shareRelayStatus) return;
  const setStatus = (message, tone = "") => {
    els.shareRelayStatus.textContent = message;
    els.shareRelayStatus.classList.remove("ok");
    els.shareRelayStatus.classList.remove("warn");
    if (tone === "ok" || tone === "warn") {
      els.shareRelayStatus.classList.add(tone);
    }
  };
  const base = getShareBaseUrl();
  if (!base) {
    const network = getShareNetworkMode();
    const message = network.warning ? `${network.message} ${network.warning}` : network.message;
    setStatus(message, network.tone);
    return;
  }
  setStatus("Share relay: checking...");
  const startedAt = performance.now();
  try {
    const res = await fetchWithTimeout(
      `${base}/api/health`,
      { method: "GET", credentials: "omit" },
      SHARE_RELAY_TIMEOUT_MS
    );
    if (res.ok) {
      const displayBase = base.replace(/^https?:\/\//i, "");
      const ms = Math.max(1, Math.round(performance.now() - startedAt));
      state.shareRelayBackoffUntil = 0;
      setStatus(`Share relay connected (${displayBase}) · ${ms}ms`, "ok");
      return;
    }
    const ms = Math.max(1, Math.round(performance.now() - startedAt));
    if (!AJL_WEB_MODE) state.shareRelayBackoffUntil = Date.now() + 15_000;
    setStatus(`Share relay unavailable right now (HTTP ${res.status}, ${ms}ms).`, "warn");
  } catch (err) {
    if (!AJL_WEB_MODE) state.shareRelayBackoffUntil = Date.now() + 15_000;
    setStatus("Share relay unavailable right now.", "warn");
  }
}

function updateShareStatusLine(message, tone = "") {
  if (!els.shareRelayStatus) return;
  els.shareRelayStatus.textContent = message;
  els.shareRelayStatus.classList.remove("ok");
  els.shareRelayStatus.classList.remove("warn");
  if (tone === "ok" || tone === "warn") {
    els.shareRelayStatus.classList.add(tone);
  }
}

function setShareBusy(busy) {
  state.shareBusy = !!busy;
  const disabled = state.shareBusy || state.readOnly;
  if (els.shareCreate) els.shareCreate.disabled = disabled;
  if (els.shareRefresh) els.shareRefresh.disabled = disabled;
  if (els.shareRegenerate) els.shareRegenerate.disabled = disabled;
  if (els.shareDisable) els.shareDisable.disabled = disabled;
  if (els.shareCopy) els.shareCopy.disabled = disabled || !state.shareInfo;
  if (els.shareLive) els.shareLive.disabled = disabled;
  if (els.shareExpiry) els.shareExpiry.disabled = disabled;
  if (els.shareExpiryCustom) els.shareExpiryCustom.disabled = disabled;
  if (els.shareOwnerLabel) els.shareOwnerLabel.disabled = disabled;
  if (els.shareIncludeAmounts) els.shareIncludeAmounts.disabled = disabled;
  if (els.shareIncludeNotes) els.shareIncludeNotes.disabled = disabled;
  if (els.shareIncludeCategories) els.shareIncludeCategories.disabled = disabled;
}

function buildSharePayload() {
  const derived = deriveInstances();
  const base = getBaseInstances(derived);
  const ownerLabel = getShareOwnerLabelValue() || state.profileName || null;
  const includeAmounts = state.shareOptions.includeAmounts !== false;
  const includeNotes = state.shareOptions.includeNotes !== false;
  const includeCategories = state.shareOptions.includeCategories !== false;
  return {
    schema_version: "1",
    period: `${state.selectedYear}-${pad2(state.selectedMonth)}`,
    owner_label: ownerLabel,
    generated_at: new Date().toISOString(),
    privacy: {
      include_amounts: includeAmounts,
      include_notes: includeNotes,
      include_categories: includeCategories,
    },
    items: base.map((item) => ({
      id: item.id,
      template_id: item.template_id,
      year: item.year,
      month: item.month,
      name_snapshot: item.name_snapshot,
      category_snapshot: includeCategories ? item.category_snapshot || null : null,
      amount: includeAmounts ? Number(item.amount || 0) : null,
      due_date: item.due_date,
      status: item.status_derived,
      paid_date: item.paid_date || null,
      amount_paid: includeAmounts ? Number(item.amount_paid || 0) : null,
      amount_remaining: includeAmounts ? Number(item.amount_remaining || 0) : null,
      essential_snapshot: !!item.essential_snapshot,
      autopay_snapshot: !!item.autopay_snapshot,
      note: includeNotes ? item.note || null : null,
    })),
    categories: includeCategories ? state.settings.categories || [] : [],
  };
}

async function loadShareInfo() {
  try {
    const res = await shareFetch("/api/shares");
    if (!res.ok) {
      if (res.status === 401) {
        updateShareStatusLine("No active owner session. Create a share link to start.", "warn");
      }
      return null;
    }
    const data = await res.json();
    return data && data.share ? data.share : null;
  } catch (err) {
    return null;
  }
}

async function publishShare(payloadOverride = null) {
  if (state.readOnly) return;
  if (!state.shareInfo || !state.shareInfo.token) return;
  const ownerLabel = getShareOwnerLabelValue() || state.profileName || null;
  const payload = payloadOverride || buildSharePayload();
  const res = await shareFetch(`/api/shares/${state.shareInfo.token}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload, schema_version: payload.schema_version, owner_label: ownerLabel }),
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res, "Unable to update shared data.");
    throw new Error(message);
  }
  const stamp = new Date().toISOString();
  state.shareInfo.last_published_at = stamp;
  updateShareStatusLine(`Shared data updated at ${formatDateTime(stamp)}.`, "ok");
}

function clearSharePublishTimers() {
  if (sharePublishTimer) {
    clearTimeout(sharePublishTimer);
    sharePublishTimer = null;
  }
  if (sharePublishRetryTimer) {
    clearTimeout(sharePublishRetryTimer);
    sharePublishRetryTimer = null;
  }
}

function getSharePublishRetryDelayMs() {
  const factor = Math.min(sharePublishRetryCount, 6);
  return Math.min(SHARE_PUBLISH_MAX_DELAY_MS, SHARE_PUBLISH_BASE_DELAY_MS * (2 ** factor));
}

function canPublishShareLive() {
  return !state.readOnly && !!(state.shareInfo && state.shareInfo.mode === "live" && state.shareInfo.is_active);
}

async function flushSharePublishQueue() {
  if (!canPublishShareLive()) return;
  if (sharePublishInFlight) return;
  if (!sharePublishDirty) return;
  sharePublishInFlight = true;
  sharePublishDirty = false;
  try {
    await publishShare();
    sharePublishRetryCount = 0;
    if (sharePublishRetryTimer) {
      clearTimeout(sharePublishRetryTimer);
      sharePublishRetryTimer = null;
    }
  } catch (err) {
    sharePublishDirty = true;
    sharePublishRetryCount += 1;
    const delay = getSharePublishRetryDelayMs();
    updateShareStatusLine(
      `${String(err?.message || "Unable to sync shared data.")} Retrying in ${Math.round(delay / 1000)}s.`,
      "warn"
    );
    if (sharePublishRetryTimer) clearTimeout(sharePublishRetryTimer);
    sharePublishRetryTimer = setTimeout(() => {
      flushSharePublishQueue().catch(() => {});
    }, delay);
  } finally {
    sharePublishInFlight = false;
    if (sharePublishDirty && !sharePublishRetryTimer) {
      sharePublishTimer = setTimeout(() => {
        flushSharePublishQueue().catch(() => {});
      }, 50);
    }
  }
}

function scheduleSharePublish(options = {}) {
  if (!canPublishShareLive()) return;
  const immediate = options.immediate === true;
  sharePublishDirty = true;
  if (sharePublishTimer) clearTimeout(sharePublishTimer);
  const delay = immediate ? 0 : 1200;
  sharePublishTimer = setTimeout(() => {
    flushSharePublishQueue().catch((err) => {
      updateShareStatusLine(String(err?.message || "Unable to sync shared data."), "warn");
    });
  }, delay);
}

async function loadSharedView(token, options = {}) {
  const silent = !!options.silent;
  try {
    const headers = {};
    if (state.sharedEtag) {
      headers["If-None-Match"] = state.sharedEtag;
    }
    const res = await shareFetch(`/api/shares/${token}`, { headers });
    if (res.status === 304) {
      hideSystemBanner();
      return;
    }
    if (!res.ok) {
      stopSharedLivePolling();
      state.sharedEtag = "";
      const data = await res.json().catch(() => ({}));
      const message = data?.error || "This link is invalid or has been disabled.";
      if (!silent) showSystemBanner(message);
      return;
    }
    hideSystemBanner();
    const data = await res.json();
    const etag = res.headers.get("etag");
    state.sharedEtag = etag ? String(etag) : "";
    const payload = data.payload || data.data || {};
    const period = payload.period || "";
    if (period && period.includes("-")) {
      const [year, month] = period.split("-").map(Number);
      if (year && month) setMonth(year, month);
    }
    state.instances = Array.isArray(payload.items) ? payload.items : [];
    state.dataVersion += 1;
    state.summaryCache = null;
    state.sharePrivacy = payload.privacy && typeof payload.privacy === "object" ? payload.privacy : null;
    state.sharedMeta = {
      mode: data.mode || payload.mode || "live",
      ownerLabel: data.ownerLabel || payload.owner_label || null,
      lastPublishedAt: data.lastPublishedAt || payload.last_published_at || null,
      expiresAt: data.expiresAt || payload.expires_at || null,
    };
    state.payments = [];
    state.settings.categories = Array.isArray(payload.categories) ? payload.categories : [];
    renderSharedHeader(payload.owner_label || data.ownerLabel, state.sharedMeta);
    startSharedLivePolling(token, state.sharedMeta.mode);
    renderView();
    renderDashboard();
  } catch (err) {
    stopSharedLivePolling();
    if (!silent) showSystemBanner("Unable to load shared list.");
  }
}

function updateShareModal() {
  if (!els.shareModal) return;
  const share = state.shareInfo;
  if (els.shareLink) {
    els.shareLink.value = share?.url || "";
  }
  if (els.shareLive) {
    els.shareLive.checked = share ? share.mode === "live" : true;
  }
  if (els.shareExpiry) {
    const inferred = inferShareExpiryPreset(share?.expires_at || null);
    state.shareExpiryPreset = inferred;
    els.shareExpiry.value = inferred;
    setShareExpiryCustomVisibility(inferred === "custom");
    if (els.shareExpiryCustom) {
      if (share?.expires_at) {
        els.shareExpiryCustom.value = toDatetimeLocalInputValue(share.expires_at);
      } else if (inferred !== "custom") {
        els.shareExpiryCustom.value = "";
      }
    }
  }
  if (els.shareOwnerLabel) {
    const value = share?.owner_label || state.shareOwnerLabel || state.profileName || "";
    els.shareOwnerLabel.value = value;
  }
  if (els.shareIncludeAmounts) {
    els.shareIncludeAmounts.checked = state.shareOptions.includeAmounts !== false;
  }
  if (els.shareIncludeNotes) {
    els.shareIncludeNotes.checked = state.shareOptions.includeNotes !== false;
  }
  if (els.shareIncludeCategories) {
    els.shareIncludeCategories.checked = state.shareOptions.includeCategories !== false;
  }
  if (els.shareCreate) {
    els.shareCreate.classList.toggle("hidden", !!share);
  }
  if (els.shareRefresh) {
    els.shareRefresh.classList.toggle("hidden", !share);
  }
  if (els.shareRegenerate) {
    els.shareRegenerate.classList.toggle("hidden", !share);
  }
  if (els.shareDisable) {
    els.shareDisable.classList.toggle("hidden", !share);
  }
  if (els.shareCopy) {
    els.shareCopy.disabled = !share;
  }
  const network = getShareNetworkMode();
  if (els.shareRelayStatus && share?.last_published_at) {
    let message = `${network.message} Last shared update: ${formatDateTime(share.last_published_at)}.`;
    if (share.expires_at) {
      message += ` Expires ${formatDateTime(share.expires_at)}.`;
    }
    if (network.warning) message += ` ${network.warning}`;
    updateShareStatusLine(message, network.warning ? "warn" : "ok");
  } else if (els.shareRelayStatus && share?.expires_at) {
    let message = `${network.message} Share link expires ${formatDateTime(share.expires_at)}.`;
    if (network.warning) message += ` ${network.warning}`;
    updateShareStatusLine(message, network.warning ? "warn" : "ok");
  } else if (els.shareRelayStatus) {
    let message = network.message;
    if (network.warning) message += ` ${network.warning}`;
    updateShareStatusLine(message, network.tone);
  }
  setShareBusy(state.shareBusy);
}

async function openShareModal() {
  if (!els.shareModal) return;
  if (state.readOnly) return;
  await ensureShareViewerBaseReady();
  refreshShareRelayStatus().catch(() => {});
  const share = await loadShareInfo();
  if (share && (share.owner_key || share.ownerKey || share.manageKey)) {
    const ownerKey = share.owner_key || share.ownerKey || share.manageKey;
    state.shareOwnerKey = ownerKey;
    saveShareOwnerKey(ownerKey);
  }
  state.shareInfo = share ? normalizeShareInfo(share) : null;
  state.shareOwnerLabel = state.shareInfo?.owner_label || state.shareOwnerLabel || state.profileName || "";
  updateShareModal();
  els.shareModal.classList.remove("hidden");
}

function closeShareModal() {
  if (!els.shareModal) return;
  els.shareModal.classList.add("hidden");
}

function normalizeShareInfo(share) {
  if (!share) return null;
  const token = share.token || share.shareToken || null;
  const url = buildShareViewerUrl(token, share.url || share.shareUrl || "");
  const expiresAt = share.expires_at || share.expiresAt || null;
  return {
    token,
    mode: share.mode || "live",
    is_active: !!share.is_active,
    owner_label: share.owner_label || null,
    last_published_at: share.last_published_at || null,
    expires_at: expiresAt,
    url,
  };
}

async function createShareLink() {
  if (state.shareBusy) return;
  setShareBusy(true);
  try {
  await ensureShareViewerBaseReady();
  const mode = els.shareLive && els.shareLive.checked ? "live" : "snapshot";
  const ownerLabel = getShareOwnerLabelValue() || state.profileName || null;
  const expiryPreset = getShareExpiryPresetValue();
  if (expiryPreset === "custom" && !fromDatetimeLocalInputValue(els.shareExpiryCustom?.value || "")) {
    updateShareStatusLine("Choose a custom expiry date/time.", "warn");
    return;
  }
  const expiresAt = getShareExpiryValue();
  if (expiryPreset !== "never" && !expiresAt) {
    updateShareStatusLine("Custom expiry must be a future date/time.", "warn");
    return;
  }
  state.shareOwnerLabel = ownerLabel || "";
  const res = await shareFetch("/api/shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, owner_label: ownerLabel, expires_at: expiresAt }),
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res, "Unable to create share link.");
    window.alert(message);
    updateShareStatusLine(message, "warn");
    return;
  }
  const data = await res.json();
  const ownerKey = data.ownerKey || data.manageKey || data.owner_key || null;
  if (ownerKey) {
    state.shareOwnerKey = ownerKey;
    saveShareOwnerKey(ownerKey);
  }
  const shareUrl = buildShareViewerUrl(data.shareToken, data.shareUrl || "");
  state.shareInfo = {
    token: data.shareToken,
    mode,
    is_active: true,
    owner_label: ownerLabel,
    expires_at: data.expires_at || expiresAt || null,
    url: shareUrl,
  };
  try {
    await publishShare(buildSharePayload());
  } catch (err) {
    const message = String(err.message || "Share created, but initial publish failed.");
    showSystemBanner(message);
    updateShareStatusLine(message, "warn");
    scheduleSharePublish({ immediate: true });
  }
  updateShareModal();
  } finally {
    setShareBusy(false);
  }
}

async function regenerateShareLink(options = {}) {
  if (state.shareBusy) return;
  setShareBusy(true);
  try {
  await ensureShareViewerBaseReady();
  if (!state.shareInfo) return;
  const confirmed =
    options.skipConfirm === true ?
      true :
      window.confirm("Regenerate link? The old link will stop working.");
  if (!confirmed) return;
  const res = await shareFetch(`/api/shares/${state.shareInfo.token}/regenerate`, { method: "POST" });
  if (!res.ok) {
    const message = await readApiErrorMessage(res, "Unable to regenerate link.");
    window.alert(message);
    updateShareStatusLine(message, "warn");
    return;
  }
  const data = await res.json();
  const ownerKey = data.ownerKey || data.manageKey || data.owner_key || null;
  if (ownerKey) {
    state.shareOwnerKey = ownerKey;
    saveShareOwnerKey(ownerKey);
  }
  state.shareInfo = {
    ...state.shareInfo,
    token: data.shareToken,
    url: buildShareViewerUrl(data.shareToken, data.shareUrl || ""),
    expires_at: data.expires_at || state.shareInfo.expires_at || null,
  };
  updateShareModal();
  updateShareStatusLine("Share link regenerated.", "ok");
  } finally {
    setShareBusy(false);
  }
}

async function disableShareLink(options = {}) {
  if (state.shareBusy) return;
  setShareBusy(true);
  try {
  if (!state.shareInfo) return;
  const confirmed =
    options.skipConfirm === true ?
      true :
      window.confirm("Disable this share link? Viewers will lose access.");
  if (!confirmed) return;
  const res = await shareFetch(`/api/shares/${state.shareInfo.token}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isActive: false }),
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res, "Unable to disable share link.");
    window.alert(message);
    updateShareStatusLine(message, "warn");
    return;
  }
  state.shareInfo = null;
  sharePublishDirty = false;
  sharePublishRetryCount = 0;
  clearSharePublishTimers();
  updateShareModal();
  updateShareStatusLine("Share link disabled.");
  } finally {
    setShareBusy(false);
  }
}

async function updateShareMode() {
  if (state.shareBusy) return;
  setShareBusy(true);
  try {
  if (!state.shareInfo) return;
  const mode = els.shareLive && els.shareLive.checked ? "live" : "snapshot";
  const ownerLabel = getShareOwnerLabelValue() || state.profileName || null;
  const expiryPreset = getShareExpiryPresetValue();
  if (expiryPreset === "custom" && !fromDatetimeLocalInputValue(els.shareExpiryCustom?.value || "")) {
    updateShareStatusLine("Choose a custom expiry date/time.", "warn");
    return;
  }
  const expiresAt = getShareExpiryValue();
  if (expiryPreset !== "never" && !expiresAt) {
    updateShareStatusLine("Custom expiry must be a future date/time.", "warn");
    return;
  }
  state.shareInfo.mode = mode;
  state.shareInfo.owner_label = ownerLabel;
  state.shareInfo.expires_at = expiresAt;
  state.shareOwnerLabel = ownerLabel || "";
  const patchRes = await shareFetch(`/api/shares/${state.shareInfo.token}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, owner_label: ownerLabel, expires_at: expiresAt }),
  });
  if (!patchRes.ok) {
    const message = await readApiErrorMessage(patchRes, "Unable to update share mode.");
    window.alert(message);
    updateShareStatusLine(message, "warn");
    return;
  }
  try {
    await publishShare(buildSharePayload());
  } catch (err) {
    const message = String(err.message || "Unable to refresh shared data.");
    showSystemBanner(message);
    updateShareStatusLine(message, "warn");
    if (mode === "live") {
      scheduleSharePublish({ immediate: true });
    }
  }
  if (mode !== "live") {
    sharePublishDirty = false;
    sharePublishRetryCount = 0;
    clearSharePublishTimers();
  }
  updateShareModal();
  } finally {
    setShareBusy(false);
  }
}

async function copyShareLink() {
  await ensureShareViewerBaseReady();
  if (state.shareInfo?.token) {
    state.shareInfo.url = buildShareViewerUrl(state.shareInfo.token, state.shareInfo.url || "");
  }
  const link = state.shareInfo?.url || "";
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    showToast("Link copied.");
  } catch (err) {
    if (els.shareLink) {
      els.shareLink.select();
      document.execCommand("copy");
      showToast("Link copied.");
    }
  }
}

async function refreshSharedNow() {
  if (state.shareBusy) return;
  setShareBusy(true);
  try {
  if (!state.shareInfo) return;
  try {
    await publishShare(buildSharePayload());
    showToast("Shared view updated.");
  } catch (err) {
    const message = String(err.message || "Unable to update shared data.");
    showSystemBanner(message);
    updateShareStatusLine(message, "warn");
    scheduleSharePublish({ immediate: true });
  }
  } finally {
    setShareBusy(false);
  }
}

async function updateShareOwnerLabel() {
  if (state.shareBusy) return;
  setShareBusy(true);
  try {
  const ownerLabel = getShareOwnerLabelValue() || null;
  const previous = state.shareInfo?.owner_label || null;
  state.shareOwnerLabel = ownerLabel || "";
  if (!state.shareInfo || !state.shareInfo.token) return;
  if (ownerLabel === previous) return;
  state.shareInfo.owner_label = ownerLabel;
  const res = await shareFetch(`/api/shares/${state.shareInfo.token}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner_label: ownerLabel }),
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res, "Unable to update display name.");
    showSystemBanner(message);
    updateShareStatusLine(message, "warn");
    return;
  }
  updateShareStatusLine("Display name updated.", "ok");
  scheduleSharePublish();
  updateShareModal();
  } finally {
    setShareBusy(false);
  }
}

async function updateShareExpiry() {
  if (state.shareBusy) return;
  setShareBusy(true);
  try {
  const preset = getShareExpiryPresetValue();
  state.shareExpiryPreset = preset;
  setShareExpiryCustomVisibility(preset === "custom");
  if (preset === "custom") {
    const customRaw = String(els.shareExpiryCustom?.value || "");
    if (!customRaw) {
      updateShareStatusLine("Choose a custom expiry date/time.", "warn");
      return;
    }
  }
  const expiresAt = getShareExpiryValue();
  if (preset !== "never" && !expiresAt) {
    updateShareStatusLine("Custom expiry must be a future date/time.", "warn");
    return;
  }
  if (!state.shareInfo || !state.shareInfo.token) {
    updateShareStatusLine(
      expiresAt ? `Link will expire ${formatDateTime(expiresAt)}.` : "Link expiry set to never."
    );
    return;
  }
  if (state.shareInfo.expires_at === expiresAt) return;
  state.shareInfo.expires_at = expiresAt;
  const res = await shareFetch(`/api/shares/${state.shareInfo.token}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expires_at: expiresAt }),
  });
  if (!res.ok) {
    const message = await readApiErrorMessage(res, "Unable to update link expiry.");
    showSystemBanner(message);
    updateShareStatusLine(message, "warn");
    return;
  }
  if (expiresAt) {
    updateShareStatusLine(`Link expires ${formatDateTime(expiresAt)}.`, "ok");
  } else {
    updateShareStatusLine("Link set to never expire.", "ok");
  }
  updateShareModal();
  } finally {
    setShareBusy(false);
  }
}

function setImportMode(mode) {
  if (!state.pendingImport) return;
  state.pendingImport.mode = mode;
  if (els.importModeChips) {
    els.importModeChips.forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.mode === mode);
    });
  }
  updateImportConflicts();
  renderImportPreview();
}

async function updateImportConflicts() {
  if (!state.pendingImport) return;
  if (state.pendingImport.mode !== "merge") {
    state.pendingImport.conflicts = 0;
    state.pendingImport.merged = null;
    return;
  }
  try {
    const res = await fetch("/api/export/backup.json");
    const current = await readApiData(res);
    const merged = mergeBackups(current, state.pendingImport.payload);
    state.pendingImport.conflicts = merged.conflicts || 0;
    state.pendingImport.merged = merged.merged;
  } catch (err) {
    state.pendingImport.conflicts = 0;
    state.pendingImport.merged = null;
  }
}

async function handleImportFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const summary = summarizeBackup(payload);
    if (!summary) throw new Error("Invalid backup file.");
    state.pendingImport = {
      fileName: file.name || "backup.json",
      payload,
      summary,
      mode: "merge",
      conflicts: 0,
      merged: null,
    };
    if (els.importModeChips) {
      els.importModeChips.forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.mode === "merge");
      });
    }
    await updateImportConflicts();
    renderImportPreview();
  } catch (err) {
    window.alert("Invalid JSON backup file.");
  }
}

async function applyImport() {
  if (!state.pendingImport) return;
  const confirmed =
    state.pendingImport.mode === "replace"
      ? window.confirm("Replace your current data with this backup? This cannot be undone.")
      : true;
  if (!confirmed) return;
  try {
    let payload = state.pendingImport.payload;
    if (state.pendingImport.mode === "merge") {
      const res = await fetch("/api/export/backup.json");
      const current = await readApiData(res);
      const merged = mergeBackups(current, state.pendingImport.payload);
      payload = merged.merged || state.pendingImport.payload;
    }
    if (!payload) {
      window.alert("Import failed. Try exporting a new backup.");
      return;
    }
    await fetch("/api/reset-local", { method: "POST" });
    await fetch("/api/import/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.pendingImport = null;
    renderImportPreview();
    await setOnboardingComplete(true);
    if (AJL_WEB_MODE && state.webMeta) {
      state.webMeta.editCountSinceBackup = 0;
      saveWebMeta(state.webMeta);
      state.lastBackupAt = state.webMeta.lastBackupAt || state.lastBackupAt;
      renderBackupStatus();
    }
    await refreshAll();
  } catch (err) {
    window.alert("Unable to import backup.");
  }
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
    share_base_url: state.settings.share_base_url || "",
    share_viewer_base_url: state.settings.share_viewer_base_url || "",
    firstRunCompleted: state.settings.firstRunCompleted,
    hasCompletedOnboarding: state.settings.hasCompletedOnboarding,
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
    if (typeof data.share_base_url === "string") {
      state.settings.share_base_url = data.share_base_url;
    }
    if (typeof data.share_viewer_base_url === "string") {
      state.settings.share_viewer_base_url = data.share_viewer_base_url;
    }
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
  recordMutation();
}

async function removeCategory(category) {
  const next = (state.settings.categories || []).filter((cat) => cat !== category);
  state.settings.categories = next;
  await saveSettings({ categories: next });
  renderCategories();
  renderCategoryFilter(state.instances || []);
  recordMutation();
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

  if (filters.preset && filters.preset !== "none") {
    list = list.filter((item) => {
      if (filters.preset === "skipped") return item.status_derived === "skipped";
      if (item.status_derived === "skipped" || item.amount_remaining <= 0) return false;
      if (filters.preset === "overdue") return currentMonth && item.due_date < today;
      if (filters.preset === "due_soon") {
        const dueSoonDays = Number(state.settings.defaults?.dueSoonDays || 7);
        const soonCutoff = new Date();
        soonCutoff.setDate(soonCutoff.getDate() + Math.max(1, dueSoonDays));
        const soonCutoffString = `${soonCutoff.getFullYear()}-${pad2(soonCutoff.getMonth() + 1)}-${pad2(soonCutoff.getDate())}`;
        return currentMonth && item.due_date >= today && item.due_date <= soonCutoffString;
      }
      if (filters.preset === "this_week") {
        const date = new Date(`${item.due_date}T00:00:00`);
        if (Number.isNaN(date.valueOf())) return false;
        const todayDate = new Date(`${today}T00:00:00`);
        const day = todayDate.getDay();
        const diffToMonday = (day + 6) % 7;
        const monday = new Date(todayDate);
        monday.setDate(todayDate.getDate() - diffToMonday);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        return date >= monday && date <= sunday;
      }
      return true;
    });
  }

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
    amount.textContent = formatMoneyDisplay(item.amount);
    const pill = document.createElement("div");
    pill.className = `status-pill ${item.status_derived === "paid" ? "done" : item.status_derived}`;
    pill.textContent = formatStatusLabel(item.status_derived);
    right.appendChild(amount);
    right.appendChild(pill);
    if (!state.readOnly && item.status_derived !== "paid" && item.status_derived !== "skipped") {
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
  if (state.readOnly) return;
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

function renderSetupCta() {
  if (!els.setupCta) return;
  const hasTemplates = Array.isArray(state.templates) && state.templates.length > 0;
  const hasItems = Array.isArray(state.instances) && state.instances.length > 0;
  const show = !hasTemplates || !hasItems;
  els.setupCta.classList.toggle("hidden", !show);
}

function renderFirstVisitHero() {
  if (!els.firstVisitHero) return;
  const hasTemplates = Array.isArray(state.templates) && state.templates.length > 0;
  const hasItems = Array.isArray(state.instances) && state.instances.length > 0;
  const isEmptyState = !hasTemplates && !hasItems && !isFirstRunCompleted();
  const hide = !isEmptyState || state.readOnly || state.safeMode;
  els.firstVisitHero.classList.toggle("hidden", hide);
  document.body.classList.toggle("landing", !hide);
  if (els.firstVisitWebNote) {
    els.firstVisitWebNote.classList.toggle("hidden", !AJL_WEB_MODE);
  }
}

function renderIntegrityStatus() {
  if (!els.integrityStatus) return;
  let label = "Integrity: Unknown";
  if (state.integrityStatus === "ok") label = "Integrity: OK";
  if (state.integrityStatus === "safe") label = "Integrity: Safe mode";
  els.integrityStatus.textContent = label;
}

async function updateStorageHealth() {
  if (!els.storageHealth) return;
  if (!AJL_WEB_MODE) {
    els.storageHealth.textContent = "";
    return;
  }
  try {
    const res = await fetch("/api/export/backup.json");
    const data = await readApiData(res);
    const raw = JSON.stringify(data || {});
    const size = raw.length * 2;
    if (size >= STORAGE_HEALTH_WARNING_BYTES) {
      els.storageHealth.textContent = "Storage health: At risk — export a backup soon.";
    } else {
      els.storageHealth.textContent = "Storage health: OK";
    }
  } catch (err) {
    els.storageHealth.textContent = "Storage health: Unknown";
  }
}

async function loadLanInfo() {
  if (AJL_WEB_MODE || !els.lanUrl) return;
  if (state.lanInfo) return;
  try {
    const res = await fetch("/api/lan");
    if (!res.ok) return;
    const data = await res.json();
    state.lanInfo = data;
    const urls = Array.isArray(data.urls) ? data.urls : [];
    if (urls.length > 0) {
      els.lanUrl.textContent = urls[0];
      if (urls.length > 1) {
        els.lanUrl.title = urls.join("\n");
      }
    }
  } catch (err) {
    // ignore
  }
}

function formatDiagnosticsOutput(data) {
  if (!data || typeof data !== "object") {
    return "No diagnostics available.";
  }
  return JSON.stringify(data, null, 2);
}

async function runDiagnostics(options = {}) {
  if (AJL_WEB_MODE || !els.diagnosticsOutput) return;
  const force = options.force === true;
  const now = Date.now();
  if (!force && diagnosticsInFlight) return;
  if (!force && now - lastDiagnosticsAt < 2500) return;
  diagnosticsInFlight = true;
  els.diagnosticsOutput.textContent = "Running diagnostics...";
  try {
    const res = await apiFetch("/api/system/diagnostics", {}, { silent: true });
    const requestId = getRequestIdFromResponse(res);
    if (!res.ok) {
      let message = `Diagnostics failed (${res.status}).`;
      try {
        const data = await res.json();
        message = getErrorMessage(data, message);
      } catch (err) {
        // ignore
      }
      if (requestId) message = `${message} (ref: ${requestId})`;
      els.diagnosticsOutput.textContent = message;
      showSystemBanner(message);
      return;
    }
    const payload = await readApiData(res);
    els.diagnosticsOutput.textContent = formatDiagnosticsOutput(payload);
    showToast("Diagnostics updated.");
    lastDiagnosticsAt = Date.now();
  } finally {
    diagnosticsInFlight = false;
  }
}

async function clearDiagnosticsCache() {
  if (AJL_WEB_MODE || !els.diagnosticsOutput) return;
  const res = await apiFetch(
    "/api/system/diagnostics/clear-llm-cache",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    { silent: true }
  );
  if (!res.ok) {
    const requestId = getRequestIdFromResponse(res);
    const payload = await res.json().catch(() => null);
    const baseMessage = getErrorMessage(payload, `Unable to clear Mamdou cache (${res.status}).`);
    const message = requestId ? `${baseMessage} (ref: ${requestId})` : baseMessage;
    showSystemBanner(message);
    return;
  }
  const payload = await readApiData(res);
  showToast(`Mamdou cache cleared (${Number(payload?.cleared || 0)} entries).`);
  await runDiagnostics({ force: true });
}

function setShannonBusy(busy) {
  const next = !!busy;
  if (els.shannonRun) els.shannonRun.disabled = next;
  if (els.shannonRunLlmRuntime) els.shannonRunLlmRuntime.disabled = next;
  if (els.shannonRefresh) els.shannonRefresh.disabled = next;
  if (els.janitorRuntimeBase) els.janitorRuntimeBase.disabled = next;
  if (els.janitorRuntimeRequired) els.janitorRuntimeRequired.disabled = next;
}

function stopShannonPolling() {
  if (shannonPollTimer) {
    clearInterval(shannonPollTimer);
    shannonPollTimer = null;
  }
}

function startShannonPolling() {
  if (shannonPollTimer) return;
  shannonPollTimer = setInterval(() => {
    if (document.hidden) return;
    loadShannonStatus({ silent: true }).catch(() => {});
  }, 1500);
}

function formatShannonOutputLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return "No Janitor run yet.";
  return lines
    .map((entry) => {
      const at = entry?.at ? new Date(entry.at).toLocaleTimeString() : "--:--:--";
      const source = String(entry?.source || "stdout").toUpperCase();
      const line = String(entry?.line || "");
      return `[${at}] [${source}] ${line}`;
    })
    .join("\n");
}

function janitorSeverityRank(value) {
  const severity = String(value || "").toUpperCase();
  if (severity === "BLOCKER") return 0;
  if (severity === "HIGH") return 1;
  if (severity === "MEDIUM") return 2;
  return 3;
}

function normalizeJanitorResults(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.results)) return [];
  const profileLabel = String(report.profile || "").trim().toLowerCase();
  const defaultSuite = profileLabel.startsWith("janitor-")
    ? profileLabel.replace("janitor-", "")
    : profileLabel || "general";
  return report.results.map((row, idx) => {
    const source = row && typeof row === "object" ? row : {};
    const title = String(source.title || source.name || `Check ${idx + 1}`);
    const suite = String(source.suite || defaultSuite || "general").toLowerCase();
    return {
      id: String(source.id || `${suite}_${idx + 1}`),
      title,
      suite,
      status: String(source.status || "unknown"),
      severity: String(source.severity || (suite === "functional" ? "MEDIUM" : "HIGH")).toUpperCase(),
      attack: source.attack || title,
      expected: source.expected || "",
      actual: source.actual || source.error || "",
      error: source.error || "",
      request: source.request || null,
      response_meta: source.response_meta || null,
      repro_curl: source.repro_curl || "",
      seed: source.seed ?? null,
    };
  });
}

function janitorSuiteLabel(suite) {
  const key = String(suite || "").toLowerCase();
  if (key === "functional") return "Functional suite";
  if (key === "adversarial") return "Adversarial suite";
  if (key === "property") return "Property suite";
  if (key === "hygiene") return "Hygiene suite";
  if (key === "llm") return "LLM suite";
  if (key === "llm-runtime") return "LLM runtime suite";
  return `${key} suite`;
}

function classifyJanitorCategory(result) {
  const haystack = `${result.title} ${result.attack} ${result.expected}`.toLowerCase();
  if (/idor|auth|privilege|owner|least privilege|csrf|token cannot mutate/.test(haystack)) {
    return "Access control";
  }
  if (/content-type|json|prototype|unicode|encoded|method override|cl\/te|path-traversal|fuzz/.test(haystack)) {
    return "Input parsing";
  }
  if (/cors|csp|security headers|xss/.test(haystack)) {
    return "Web security";
  }
  if (/rate limit|flood|retry-after|spoofing/.test(haystack)) {
    return "Abuse resistance";
  }
  if (/idempot|invariant|concurrency|parallel mutation|replay/.test(haystack)) {
    return "Ledger invariants";
  }
  if (/redact|leak|diagnostics/.test(haystack)) {
    return "Data leakage";
  }
  if (/llm|provider|advisor/.test(haystack)) {
    return "LLM runtime";
  }
  return "General";
}

function getJanitorReportSummary(report) {
  const summary = report?.summary && typeof report.summary === "object" ? report.summary : {};
  return {
    total: Number(summary.total || 0),
    passed: Number(summary.passed || 0),
    failed: Number(summary.failed || 0),
    durationMs: Number(summary.duration_ms || 0),
    bySeverity: summary.by_severity && typeof summary.by_severity === "object" ? summary.by_severity : {},
  };
}

function getJanitorSuiteSummary(report, results) {
  if (report?.suites && typeof report.suites === "object") {
    const out = {};
    Object.entries(report.suites).forEach(([suite, summary]) => {
      if (!summary || typeof summary !== "object") return;
      out[String(suite).toLowerCase()] = summary;
    });
    return out;
  }
  const bySuite = {};
  results.forEach((row) => {
    const suite = String(row.suite || "general").toLowerCase();
    if (!bySuite[suite]) {
      bySuite[suite] = { total: 0, passed: 0, failed: 0 };
    }
    bySuite[suite].total += 1;
    if (row.status === "passed") bySuite[suite].passed += 1;
    if (row.status === "failed") bySuite[suite].failed += 1;
  });
  return bySuite;
}

function filterJanitorResults(results) {
  const filter = state.janitorFilter || {};
  const statusFilter = String(filter.status || "all");
  const severityFilter = String(filter.severity || "all").toUpperCase();
  const suiteFilter = String(filter.suite || "all").toLowerCase();
  const search = String(filter.search || "").trim().toLowerCase();
  return results.filter((row) => {
    if (statusFilter !== "all" && row.status !== statusFilter) return false;
    if (severityFilter !== "ALL" && row.severity !== severityFilter) return false;
    if (suiteFilter !== "all" && row.suite !== suiteFilter) return false;
    if (!search) return true;
    const haystack = `${row.title} ${row.attack} ${row.expected} ${row.actual} ${row.suite}`.toLowerCase();
    return haystack.includes(search);
  });
}

function renderJanitorVerdict(stateData, report, results) {
  if (!els.janitorVerdict) return;
  const verdictEl = els.janitorVerdict;
  verdictEl.classList.remove("neutral", "pass", "warn", "fail");
  if (stateData.running) {
    verdictEl.classList.add("warn");
    verdictEl.textContent = "Audit running. Results update in real time.";
    return;
  }
  if (!report || !results.length) {
    verdictEl.classList.add("neutral");
    verdictEl.textContent = "Run Janitor to generate an audit verdict.";
    return;
  }
  const failed = results.filter((row) => row.status === "failed");
  const skipped = results.filter((row) => row.status === "skipped").length;
  const blockerFails = failed.filter((row) => row.severity === "BLOCKER").length;
  if (skipped === results.length) {
    verdictEl.classList.add("warn");
    verdictEl.textContent = "Runtime checks skipped: start local app and connect Mamdou, then rerun.";
    return;
  }
  if (failed.length === 0) {
    verdictEl.classList.add("pass");
    verdictEl.textContent = "Ship-ready: all Janitor checks passed.";
    return;
  }
  if (blockerFails > 0) {
    verdictEl.classList.add("fail");
    verdictEl.textContent = `Do not ship: ${blockerFails} blocker check${blockerFails === 1 ? "" : "s"} failed.`;
    return;
  }
  verdictEl.classList.add("warn");
  verdictEl.textContent = `Warning: ${failed.length} non-blocker check${failed.length === 1 ? "" : "s"} failed.`;
}

function renderJanitorSuiteSummary(report, results) {
  if (!els.janitorSuiteSummary) return;
  els.janitorSuiteSummary.innerHTML = "";
  if (!report || !results.length) return;
  const suites = getJanitorSuiteSummary(report, results);
  const suiteOrder = ["functional", "adversarial", "property", "hygiene", "llm", "llm-runtime"];
  const suiteKeys = Object.keys(suites);
  suiteKeys.sort((a, b) => {
    const aIdx = suiteOrder.indexOf(a);
    const bIdx = suiteOrder.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  });
  suiteKeys.forEach((suite) => {
    const summary = suites[suite];
    if (!summary) return;
    const total = Number(summary.total || 0);
    const passed = Number(summary.passed || 0);
    const failed = Number(summary.failed || 0);
    const skipped = Number(summary.skipped || 0);
    const card = document.createElement("div");
    card.className = "janitor-suite-card";
    const label = document.createElement("div");
    label.className = "janitor-suite-label";
    label.textContent = janitorSuiteLabel(suite);
    const value = document.createElement("div");
    value.className = "janitor-suite-value";
    value.textContent = `${passed}/${total} passed`;
    const meta = document.createElement("div");
    meta.className = "janitor-row-meta";
    if (failed > 0) {
      meta.textContent = skipped > 0 ? `${failed} failed · ${skipped} skipped` : `${failed} failed`;
    } else if (skipped > 0) {
      meta.textContent = `${skipped} skipped`;
    } else {
      meta.textContent = "No failures";
    }
    card.append(label, value, meta);
    els.janitorSuiteSummary.appendChild(card);
  });
}

function syncJanitorSuiteFilterOptions(results) {
  if (!els.janitorFilterSuite) return;
  const knownOrder = ["adversarial", "functional", "property", "hygiene", "llm", "llm-runtime"];
  const suites = Array.from(new Set((results || []).map((row) => String(row.suite || "").toLowerCase()).filter(Boolean)));
  suites.sort((a, b) => {
    const aIdx = knownOrder.indexOf(a);
    const bIdx = knownOrder.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  });
  const current = String(els.janitorFilterSuite.value || "all").toLowerCase();
  const html = ['<option value="all">All suites</option>']
    .concat(
      suites.map((suite) => `<option value="${suite}">${janitorSuiteLabel(suite).replace(" suite", "")}</option>`)
    )
    .join("");
  if (els.janitorFilterSuite.innerHTML !== html) {
    els.janitorFilterSuite.innerHTML = html;
  }
  if (current !== "all" && suites.includes(current)) {
    els.janitorFilterSuite.value = current;
  } else if (current !== "all" && !suites.includes(current)) {
    els.janitorFilterSuite.value = "all";
    state.janitorFilter.suite = "all";
  }
}

function renderJanitorFindingDetail(result) {
  if (!els.janitorDetailContent) return;
  els.janitorDetailContent.innerHTML = "";
  if (!result) {
    const empty = document.createElement("div");
    empty.className = "janitor-empty";
    empty.textContent = "Select a check to inspect details.";
    els.janitorDetailContent.appendChild(empty);
    return;
  }
  const title = document.createElement("div");
  title.className = "janitor-detail-title";
  title.textContent = result.title;
  const lines = [
    ["Suite", result.suite],
    ["Category", classifyJanitorCategory(result)],
    ["Severity", result.severity],
    ["Status", result.status],
  ];
  if (result.seed !== null && result.seed !== undefined && result.seed !== "") {
    lines.push(["Seed", String(result.seed)]);
  }
  lines.forEach(([label, value]) => {
    const line = document.createElement("div");
    line.className = "janitor-detail-line";
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;
    line.appendChild(strong);
    line.appendChild(document.createTextNode(String(value || "—")));
    els.janitorDetailContent.appendChild(line);
  });

  const addCodeBlock = (label, content) => {
    if (!content) return;
    const line = document.createElement("div");
    line.className = "janitor-detail-line";
    const strong = document.createElement("strong");
    strong.textContent = `${label}:`;
    line.appendChild(strong);
    const pre = document.createElement("pre");
    pre.className = "janitor-code";
    pre.textContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    line.appendChild(pre);
    els.janitorDetailContent.appendChild(line);
  };

  addCodeBlock("Attack", result.attack);
  addCodeBlock("Expected", result.expected);
  addCodeBlock("Actual", result.actual || result.error);
  if (result.request) addCodeBlock("Request", result.request);
  if (result.response_meta) addCodeBlock("Response", result.response_meta);
  if (result.repro_curl) addCodeBlock("Repro", result.repro_curl);

  const detailText = `${result.id} ${result.title} ${result.actual} ${result.error}`.toLowerCase();
  const isLlmRuntimeCase =
    /llm-runtime|runtime_target_reachable|provider_connectivity_live|advisor_query_live/.test(detailText);

  if (
    !AJL_WEB_MODE &&
    isLlmRuntimeCase &&
    (result.status === "skipped" || /not reachable|unable to reach target/.test(detailText))
  ) {
    let runtimePort = 6709;
    try {
      const runtimeBase = String(state.janitorRuntimeBase || "").trim();
      if (runtimeBase) {
        const parsed = new URL(runtimeBase);
        const parsedPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
        if (Number.isInteger(parsedPort) && parsedPort > 0) {
          runtimePort = parsedPort;
        }
      }
    } catch (err) {
      runtimePort = 6709;
    }

    const actions = document.createElement("div");
    actions.className = "assistant-actions";

    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "btn-small";
    startBtn.textContent = "Copy local start command";
    startBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(`cd /path/to/AuJourLeJour && PORT=${runtimePort} ./start.sh`);
        showToast("Start command copied.");
      } catch (err) {
        showToast("Unable to copy start command.");
      }
    });

    const rerunBtn = document.createElement("button");
    rerunBtn.type = "button";
    rerunBtn.className = "btn-small";
    rerunBtn.textContent = "Run LLM Runtime";
    rerunBtn.addEventListener("click", async () => {
      await runShannonMode("llm-runtime");
    });

    actions.append(startBtn, rerunBtn);
    els.janitorDetailContent.appendChild(actions);
  }

  if (
    !AJL_WEB_MODE &&
    result.status === "failed" &&
    /provider_connectivity_live|advisor_query_live|qwen|openai|anthropic|provider/i.test(
      `${result.id} ${result.title} ${result.actual}`
    )
  ) {
    const actions = document.createElement("div");
    actions.className = "assistant-actions";
    const openSetupBtn = document.createElement("button");
    openSetupBtn.type = "button";
    openSetupBtn.className = "btn-small";
    openSetupBtn.textContent = "Open Mamdou setup";
    openSetupBtn.addEventListener("click", () => {
      openSetupAgentSection();
    });
    actions.appendChild(openSetupBtn);
    els.janitorDetailContent.appendChild(actions);
  }
}

function renderJanitorFindings(report) {
  if (!els.janitorFindingsList) return;
  const allResults = normalizeJanitorResults(report);
  syncJanitorSuiteFilterOptions(allResults);
  const sorted = allResults.sort((a, b) => {
    const statusRank = (value) => {
      const key = String(value || "").toLowerCase();
      if (key === "failed") return 0;
      if (key === "skipped") return 1;
      if (key === "passed") return 2;
      return 3;
    };
    if (a.status !== b.status) return statusRank(a.status) - statusRank(b.status);
    const severityDelta = janitorSeverityRank(a.severity) - janitorSeverityRank(b.severity);
    if (severityDelta !== 0) return severityDelta;
    return a.title.localeCompare(b.title);
  });
  const filtered = filterJanitorResults(sorted);
  if (els.janitorFindingsCount) {
    els.janitorFindingsCount.textContent = `${filtered.length} visible`;
  }
  if (!state.janitorSelectedId || !filtered.some((row) => row.id === state.janitorSelectedId)) {
    state.janitorSelectedId = filtered[0]?.id || "";
  }

  els.janitorFindingsList.innerHTML = "";
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "janitor-empty";
    empty.textContent = allResults.length
      ? "No checks match current filters."
      : "No Janitor report results available yet.";
    els.janitorFindingsList.appendChild(empty);
    renderJanitorFindingDetail(null);
    return;
  }

  filtered.forEach((row) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "janitor-finding-row";
    if (row.id === state.janitorSelectedId) {
      button.classList.add("active");
    }
    button.addEventListener("click", () => {
      state.janitorSelectedId = row.id;
      renderJanitorFindings(state.janitorReport);
    });

    const top = document.createElement("div");
    top.className = "janitor-row-top";
    const title = document.createElement("div");
    title.className = "janitor-row-title";
    title.textContent = row.title;
    const statusBadge = document.createElement("span");
    const statusKey = String(row.status || "").toLowerCase();
    const statusClass = statusKey === "failed" ? "fail" : statusKey === "passed" ? "pass" : "neutral";
    statusBadge.className = `janitor-badge ${statusClass}`;
    statusBadge.textContent = row.status;
    top.append(title, statusBadge);

    const meta = document.createElement("div");
    meta.className = "janitor-row-meta";
    const severityBadge = document.createElement("span");
    severityBadge.className = `janitor-badge ${row.severity}`;
    severityBadge.textContent = row.severity;
    meta.append(
      `${row.suite} • ${classifyJanitorCategory(row)} • `,
      severityBadge
    );

    button.append(top, meta);
    els.janitorFindingsList.appendChild(button);
  });

  const selected = filtered.find((row) => row.id === state.janitorSelectedId) || filtered[0];
  renderJanitorFindingDetail(selected || null);
}

function renderJanitorDashboard(stateData) {
  const report = state.janitorReport;
  const results = normalizeJanitorResults(report);
  renderJanitorVerdict(stateData, report, results);
  renderJanitorSuiteSummary(report, results);
  renderJanitorFindings(report);
}

function formatShannonDuration(durationMs) {
  const value = Number(durationMs || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = Math.round(seconds % 60);
  return `${minutes}m ${remainSec}s`;
}

function renderShannonState(snapshot) {
  if (!els.shannonStatus || !els.shannonOutput) return;
  const stateData = snapshot && typeof snapshot === "object" ? snapshot : {};
  if (typeof stateData.runtime_base === "string" && stateData.runtime_base.trim()) {
    state.janitorRuntimeBase = normalizeJanitorRuntimeBase(stateData.runtime_base);
  }
  if (typeof stateData.runtime_required === "boolean") {
    state.janitorRuntimeRequired = !!stateData.runtime_required;
  }
  syncJanitorRuntimeControls();
  const running = !!stateData.running;
  const runId = String(stateData.run_id || "");
  const profile = String(stateData.profile || "full");
  const phase = stateData.phase ? String(stateData.phase) : "";
  const exitCode =
    stateData.exit_code === null || stateData.exit_code === undefined ? "—" : String(stateData.exit_code);
  const logLines = Number(stateData.log_lines || 0);
  const startedAt = stateData.started_at ? formatDateTime(stateData.started_at) : "—";
  const finishedAt = stateData.finished_at ? formatDateTime(stateData.finished_at) : "—";
  const pid = stateData.pid ? ` PID ${stateData.pid}.` : "";

  if (running) {
    const phaseLabel = phase ? ` (${phase})` : "";
    els.shannonStatus.textContent = `Running Janitor ${profile}${phaseLabel}…${pid} Started ${startedAt}.`;
  } else if (runId) {
    els.shannonStatus.textContent = `Last run ${runId.slice(0, 8)}… finished ${finishedAt} (exit ${exitCode}).`;
  } else {
    els.shannonStatus.textContent = "Idle.";
  }

  const summary = stateData.report?.summary || null;
  if (els.shannonSummary) {
    if (summary && typeof summary === "object") {
      const duration = formatShannonDuration(summary.duration_ms);
      const severity = summary.by_severity || {};
      const total = Number(summary.total || 0);
      const passed = Number(summary.passed || 0);
      const failed = Number(summary.failed || 0);
      const skipped = Number(summary.skipped || 0);
      const profileSummary = summary.by_profile;
      const runtimeBaseText = state.janitorRuntimeBase
        ? state.janitorRuntimeBase
        : "default";
      const runtimeModeText = state.janitorRuntimeRequired ? "required" : "best-effort";
      const sevLine = `B:${Number(severity.BLOCKER || 0)} H:${Number(severity.HIGH || 0)} M:${Number(
        severity.MEDIUM || 0
      )}`;
      let profileLine = "";
      if (profileSummary && typeof profileSummary === "object") {
        const order = ["functional", "adversarial", "property", "hygiene", "llm", "llm-runtime"];
        const suites = Object.keys(profileSummary);
        suites.sort((a, b) => {
          const aIdx = order.indexOf(a);
          const bIdx = order.indexOf(b);
          if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
          if (aIdx !== -1) return -1;
          if (bIdx !== -1) return 1;
          return a.localeCompare(b);
        });
        const parts = suites.map((suite) => {
          const passedCount = Number(profileSummary[suite]?.passed || 0);
          const totalCount = Number(profileSummary[suite]?.total || 0);
          const label = janitorSuiteLabel(suite).replace(" suite", "");
          return `${label} ${passedCount}/${totalCount}`;
        });
        if (parts.length > 0) {
          profileLine = ` · ${parts.join(", ")}`;
        }
      }
      els.shannonSummary.textContent = `Report: ${passed}/${total} passed, ${failed} failed${
        duration ? ` in ${duration}` : ""
      }${skipped > 0 ? `, ${skipped} skipped` : ""}${profileLine} · runtime ${runtimeBaseText} (${runtimeModeText}) · ${sevLine}`;
    } else if (runId) {
      els.shannonSummary.textContent = `Log lines: ${logLines}.`;
    } else {
      els.shannonSummary.textContent = "";
    }
  }

  els.shannonOutput.textContent = formatShannonOutputLines(stateData.logs_tail);
  renderJanitorDashboard(stateData);
  if (running) {
    startShannonPolling();
  } else {
    stopShannonPolling();
  }
}

async function loadJanitorReport(options = {}) {
  if (AJL_WEB_MODE) return;
  if (janitorReportInFlight) return;
  janitorReportInFlight = true;
  const silent = options.silent === true;
  try {
    const res = await apiFetch("/api/system/janitor/report", {}, { silent: true });
    if (res.status === 404) {
      state.janitorReport = null;
      renderJanitorDashboard({ running: false });
      return;
    }
    const requestId = getRequestIdFromResponse(res);
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      const baseMessage = getErrorMessage(payload, `Unable to load Janitor report (${res.status}).`);
      const message = requestId ? `${baseMessage} (ref: ${requestId})` : baseMessage;
      if (!silent) showSystemBanner(message);
      return;
    }
    const payload = await readApiData(res);
    const report = payload?.report || payload || null;
    state.janitorReport = report && typeof report === "object" ? report : null;
    renderJanitorDashboard({ running: false });
  } finally {
    janitorReportInFlight = false;
  }
}

async function loadShannonStatus(options = {}) {
  if (AJL_WEB_MODE || !els.shannonOutput) return;
  const force = options.force === true;
  const silent = options.silent === true;
  if (!force && shannonInFlight) return;
  shannonInFlight = true;
  setShannonBusy(true);
  if (!silent) els.shannonStatus.textContent = "Loading Janitor status...";
  try {
    const res = await apiFetch("/api/system/janitor/status", {}, { silent: true });
    const requestId = getRequestIdFromResponse(res);
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      const baseMessage = getErrorMessage(payload, `Unable to load Janitor status (${res.status}).`);
      const message = requestId ? `${baseMessage} (ref: ${requestId})` : baseMessage;
      els.shannonStatus.textContent = message;
      if (!silent) showSystemBanner(message);
      return;
    }
    const payload = await readApiData(res);
    const stateData = payload?.state || payload || {};
    renderShannonState(stateData);
    if (!stateData.running) {
      await loadJanitorReport({ silent: true });
    }
    const runId = String(stateData.run_id || "");
    const running = !!stateData.running;
    if (runId && runId !== shannonLastRunId) {
      shannonLastRunId = runId;
      shannonLastRunning = running;
      if (!silent && running) showToast("Janitor started.");
    } else if (runId && shannonLastRunning && !running) {
      shannonLastRunning = false;
      if (!silent) showToast(`Janitor finished (exit ${stateData.exit_code ?? "?"}).`);
    } else {
      shannonLastRunning = running;
    }
  } finally {
    shannonInFlight = false;
    setShannonBusy(false);
  }
}

async function runShannonMode(profile = "full") {
  if (AJL_WEB_MODE || !els.shannonOutput) return;
  if (shannonInFlight) return;
  const runProfile = profile === "llm-runtime" ? "llm-runtime" : "full";
  const runtimeCandidate = String(
    els.janitorRuntimeBase?.value ?? state.janitorRuntimeBase ?? ""
  );
  const runtimeValidated = validateJanitorRuntimeBase(runtimeCandidate);
  if (!runtimeValidated.ok) {
    showSystemBanner(runtimeValidated.error);
    return;
  }
  const runtimeBase = runtimeValidated.value;
  const runtimeRequired =
    !!(els.janitorRuntimeRequired?.checked ?? state.janitorRuntimeRequired);
  state.janitorRuntimeBase = runtimeBase;
  state.janitorRuntimeRequired = runtimeRequired;
  saveJanitorRuntimeSettings();
  syncJanitorRuntimeControls();
  const payload = {
    profile: runProfile,
    runtime_required: runtimeRequired,
  };
  if (runtimeBase) {
    payload.runtime_base = runtimeBase;
  }
  shannonInFlight = true;
  setShannonBusy(true);
  try {
    els.shannonStatus.textContent = runProfile === "llm-runtime"
      ? "Starting Janitor LLM runtime probe..."
      : "Starting Janitor...";
    const res = await apiFetch(
      "/api/system/janitor/run",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      { silent: true }
    );
    const requestId = getRequestIdFromResponse(res);
    const payload = await readApiData(res);
    if (!res.ok) {
      const baseMessage = getErrorMessage(payload, `Unable to run Janitor (${res.status}).`);
      const message = requestId ? `${baseMessage} (ref: ${requestId})` : baseMessage;
      els.shannonStatus.textContent = message;
      showSystemBanner(message);
      return;
    }
    renderShannonState(payload?.state || {});
    state.janitorReport = null;
    renderJanitorDashboard(payload?.state || {});
    showToast(runProfile === "llm-runtime" ? "Janitor LLM runtime probe started." : "Janitor started.");
    await loadShannonStatus({ force: true, silent: true });
  } finally {
    shannonInFlight = false;
    setShannonBusy(false);
  }
}

async function copyShannonOutput() {
  if (AJL_WEB_MODE || !els.shannonOutput) return;
  const lines = [
    String(els.shannonStatus?.textContent || "").trim(),
    String(els.shannonSummary?.textContent || "").trim(),
    "",
    String(els.shannonOutput?.textContent || "").trim(),
  ]
    .filter((line, idx, arr) => !(idx === arr.length - 1 && !line))
    .join("\n");
  if (!lines.trim()) {
    showToast("Nothing to copy yet.");
    return;
  }
  try {
    await navigator.clipboard.writeText(lines);
    showToast("Janitor output copied.");
  } catch (err) {
    showToast("Unable to copy Janitor output.");
  }
}

async function copyJanitorRepro() {
  if (AJL_WEB_MODE) return;
  const results = normalizeJanitorResults(state.janitorReport);
  const selected = results.find((row) => row.id === state.janitorSelectedId);
  if (!selected || !selected.repro_curl) {
    showToast("No repro command for selected check.");
    return;
  }
  try {
    await navigator.clipboard.writeText(String(selected.repro_curl));
    showToast("Repro command copied.");
  } catch (err) {
    showToast("Unable to copy repro command.");
  }
}

function syncJanitorFilterControls() {
  if (els.janitorFilterStatus) els.janitorFilterStatus.value = state.janitorFilter.status;
  if (els.janitorFilterSeverity) els.janitorFilterSeverity.value = state.janitorFilter.severity;
  if (els.janitorFilterSuite) els.janitorFilterSuite.value = state.janitorFilter.suite;
  if (els.janitorSearch && els.janitorSearch.value !== state.janitorFilter.search) {
    els.janitorSearch.value = state.janitorFilter.search;
  }
}

function syncJanitorRuntimeControls() {
  if (els.janitorRuntimeBase && document.activeElement !== els.janitorRuntimeBase) {
    els.janitorRuntimeBase.value = state.janitorRuntimeBase || "";
  }
  if (els.janitorRuntimeRequired) {
    els.janitorRuntimeRequired.checked = !!state.janitorRuntimeRequired;
  }
}

function applyJanitorRuntimeControlUpdate() {
  const candidate = String(els.janitorRuntimeBase?.value ?? state.janitorRuntimeBase ?? "");
  const validated = validateJanitorRuntimeBase(candidate);
  if (!validated.ok) {
    showSystemBanner(validated.error);
    syncJanitorRuntimeControls();
    return false;
  }
  if (els.janitorRuntimeBase) {
    state.janitorRuntimeBase = validated.value;
  }
  if (els.janitorRuntimeRequired) {
    state.janitorRuntimeRequired = !!els.janitorRuntimeRequired.checked;
  }
  saveJanitorRuntimeSettings();
  syncJanitorRuntimeControls();
  hideSystemBanner();
  return true;
}

function applyJanitorFilterUpdate() {
  state.janitorFilter.status = String(els.janitorFilterStatus?.value || "all");
  state.janitorFilter.severity = String(els.janitorFilterSeverity?.value || "all");
  state.janitorFilter.suite = String(els.janitorFilterSuite?.value || "all");
  state.janitorFilter.search = String(els.janitorSearch?.value || "").trim();
  renderJanitorFindings(state.janitorReport);
}

function maybeShowFirstRunWizard() {
  if (!AJL_WEB_MODE || !state.webMeta || !els.wizardModal) return;
  if (state.webMeta.hasCompletedOnboarding) return;
  const hasTemplates = Array.isArray(state.templates) && state.templates.length > 0;
  const hasItems = Array.isArray(state.instances) && state.instances.length > 0;
  const isEmptyState = !hasTemplates && !hasItems && !isFirstRunCompleted();
  if (isEmptyState) {
    // Landing hero replaces the old wizard for empty-state onboarding.
    return;
  }
  if (hasTemplates || hasItems) {
    state.webMeta.firstRunCompleted = true;
    state.webMeta.hasCompletedOnboarding = true;
    saveWebMeta(state.webMeta);
    return;
  }
  els.wizardModal.classList.remove("hidden");
}

function closeWizard() {
  if (!els.wizardModal) return;
  els.wizardModal.classList.add("hidden");
}

function applyReadOnlyPreview(enabled) {
  if (!AJL_WEB_MODE) return;
  setReadOnlyMode(enabled);
  if (enabled) {
    if (els.sharedHeader) {
      els.sharedHeader.classList.add("hidden");
      els.sharedHeader.classList.remove("visible");
    }
    showSystemBanner("Read-only preview (sharing simulation).");
  } else {
    if (els.systemBanner) els.systemBanner.classList.add("hidden");
  }
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

function openLogUpdateFor(instanceId) {
  openInstanceDetail(instanceId);
  if (state.readOnly) return;
  setTimeout(() => {
    if (els.detailLogAmount) {
      els.detailLogAmount.focus();
      els.detailLogAmount.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, 80);
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
  remainingValue.textContent = formatMoneyDisplay(summary.remaining);
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
  doneSub.textContent = `${formatMoneyDisplay(summary.paid)} of ${formatMoneyDisplay(summary.required)}`;
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
  timeSub.textContent = paidCount > 0 ? `Avg ${avgDays} days vs due` : "No completed bills";
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
      `${name} on ${formatShortDate(firstPayment.paid_date)} (${formatMoneyDisplay(firstPayment.amount)})`
    );
  }
  if (lastPayment) {
    const name = nameMap.get(lastPayment.instance_id) || "Update";
    addRow(
      "Last update",
      `${name} on ${formatShortDate(lastPayment.paid_date)} (${formatMoneyDisplay(lastPayment.amount)})`
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

function exportReviewCsv() {
  const derived = deriveInstances();
  const baseList = getBaseInstances(derived);
  const payments = state.payments || [];
  const lastPaidMap = new Map();
  payments.forEach((payment) => {
    const current = lastPaidMap.get(payment.instance_id);
    if (!current || payment.paid_date > current) {
      lastPaidMap.set(payment.instance_id, payment.paid_date);
    }
  });
  const lines = [
    [
      "name",
      "category",
      "due_date",
      "status",
      "amount",
      "amount_paid",
      "amount_remaining",
      "last_update",
    ].join(","),
  ];
  baseList.forEach((item) => {
    const row = [
      item.name_snapshot,
      item.category_snapshot || "",
      item.due_date || "",
      item.status_derived || item.status || "",
      Number(item.amount || 0),
      Number(item.amount_paid || 0),
      Number(item.amount_remaining || 0),
      lastPaidMap.get(item.id) || item.paid_date || "",
    ].map(escapeCsv);
    lines.push(row.join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `au_jour_le_jour_review_${state.selectedYear}-${pad2(
    state.selectedMonth
  )}.csv`;
  link.click();
  URL.revokeObjectURL(url);
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
      recordMutation();
    });

    archiveBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      await fetch(`/api/templates/${template.id}/archive`, { method: "POST" });
      await refreshAll();
      recordMutation();
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
      recordMutation();
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
  renderFirstVisitHero();
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
  if (state.view === "janitor" && AJL_WEB_MODE) {
    state.view = "setup";
  }
  const isToday = state.view === "today";
  const isReview = state.view === "review";
  const isSetup = state.view === "setup";
  const isJanitor = state.view === "janitor";

  if (els.todayView) els.todayView.classList.toggle("hidden", !isToday);
  if (els.reviewView) els.reviewView.classList.toggle("hidden", !isReview);
  if (els.setupView) els.setupView.classList.toggle("hidden", !isSetup);
  if (els.janitorView) els.janitorView.classList.toggle("hidden", !isJanitor);

  if (els.navToday) els.navToday.classList.toggle("active", isToday);
  if (els.navReview) els.navReview.classList.toggle("active", isReview);
  if (els.navSetup) els.navSetup.classList.toggle("active", isSetup);
  if (els.navJanitor) els.navJanitor.classList.toggle("active", isJanitor);

  updateSplitView(true);
  if (!isToday && els.detailsDrawer) {
    els.detailsDrawer.classList.add("hidden");
  }
  if (!isToday && els.detailsPane) {
    els.detailsPane.classList.add("hidden");
  }
  if (!isJanitor) {
    stopShannonPolling();
  }
  if (isSetup) {
    renderDefaults();
    renderCategories();
    renderBackupStatus();
    renderImportPreview();
    renderSetupCta();
    updateStorageHealth();
    renderIntegrityStatus();
    renderSetupAgentConnection();
    if (AJL_WEB_MODE && els.previewReadonly && state.webMeta) {
      els.previewReadonly.checked = !!state.webMeta.readOnlyPreview;
    }
  }
  if (isJanitor && !AJL_WEB_MODE) {
    syncJanitorFilterControls();
    if (els.diagnosticsOutput) runDiagnostics();
    if (els.shannonOutput) {
      loadShannonStatus({ silent: true }).catch(() => {});
      loadJanitorReport({ silent: true }).catch(() => {});
    }
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
      loadLlmProviderStatus({ silent: true }),
      loadQwenAuthStatus(),
      loadCommandLog(),
      loadChatHistory(),
    ]);
    const valid = validateLoadedState();
    if (!valid.ok) {
      enterSafeMode(valid.reason);
      state.view = "setup";
      renderView();
      return;
    }
    state.integrityStatus = "ok";
    renderIntegrityStatus();
    renderDefaults();
    renderCategories();
    renderDashboard();
    scheduleNudgeRefresh();
    renderTemplates();
    renderSetupCta();
    updateStorageHealth();
    maybeShowFirstRunWizard();
    scheduleSharePublish();
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
    scheduleNudgeRefresh();
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

  if (els.navJanitor) {
    els.navJanitor.addEventListener("click", () => {
      if (AJL_WEB_MODE) return;
      state.view = "janitor";
      renderView();
    });
  }

  if (els.shareOpen) {
    els.shareOpen.addEventListener("click", () => openShareModal());
  }
  if (els.shareClose) {
    els.shareClose.addEventListener("click", () => closeShareModal());
  }
  if (els.shareModal) {
    els.shareModal.addEventListener("click", (event) => {
      if (event.target === els.shareModal) closeShareModal();
    });
  }
  if (els.shareCopy) {
    els.shareCopy.addEventListener("click", () => copyShareLink());
  }
  if (els.shareCreate) {
    els.shareCreate.addEventListener("click", () => createShareLink());
  }
  if (els.shareRefresh) {
    els.shareRefresh.addEventListener("click", () => refreshSharedNow());
  }
  if (els.shareRegenerate) {
    els.shareRegenerate.addEventListener("click", () => regenerateShareLink());
  }
  if (els.shareDisable) {
    els.shareDisable.addEventListener("click", () => disableShareLink());
  }
  if (els.shareLive) {
    els.shareLive.addEventListener("change", () => updateShareMode());
  }
  if (els.shareExpiry) {
    els.shareExpiry.addEventListener("change", () => updateShareExpiry());
  }
  if (els.shareExpiryCustom) {
    els.shareExpiryCustom.addEventListener("change", () => {
      if (getShareExpiryPresetValue() === "custom") {
        updateShareExpiry();
      }
    });
  }
  if (els.shareOwnerLabel) {
    els.shareOwnerLabel.addEventListener("change", () => updateShareOwnerLabel());
    els.shareOwnerLabel.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        updateShareOwnerLabel();
      }
    });
  }
  const syncSharePrivacy = () => {
    state.shareOptions.includeAmounts = !!els.shareIncludeAmounts?.checked;
    state.shareOptions.includeNotes = !!els.shareIncludeNotes?.checked;
    state.shareOptions.includeCategories = !!els.shareIncludeCategories?.checked;
    saveShareOptions();
    if (state.shareInfo && state.shareInfo.is_active) {
      publishShare(buildSharePayload()).catch(() => {});
    }
  };
  if (els.shareIncludeAmounts) {
    els.shareIncludeAmounts.addEventListener("change", syncSharePrivacy);
  }
  if (els.shareIncludeNotes) {
    els.shareIncludeNotes.addEventListener("change", syncSharePrivacy);
  }
  if (els.shareIncludeCategories) {
    els.shareIncludeCategories.addEventListener("change", syncSharePrivacy);
  }

  if (els.backupOpen) {
    els.backupOpen.addEventListener("click", () => {
      state.view = "setup";
      renderView();
      els.backupSection?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  if (els.statusExpand) {
    els.statusExpand.addEventListener("click", () => {
      state.summaryExpanded = !state.summaryExpanded;
      renderDashboard();
    });
  }

  if (els.markAllOverdue) {
    els.markAllOverdue.addEventListener("click", async () => {
      const result = await markQueueItemsDone("overdue", { confirm: true, toast: true });
      if (!result.ok && result.done === 0 && result.message && result.message !== "Canceled.") {
        window.alert(result.message);
      }
    });
  }

  if (els.markAllSoon) {
    els.markAllSoon.addEventListener("click", async () => {
      const result = await markQueueItemsDone("dueSoon", { confirm: true, toast: true });
      if (!result.ok && result.done === 0 && result.message && result.message !== "Canceled.") {
        window.alert(result.message);
      }
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
    const now = Date.now();
    state.lastBackupAt = now;
    if (AJL_WEB_MODE && state.webMeta) {
      state.webMeta.lastBackupAt = now;
      state.webMeta.editCountSinceBackup = 0;
      state.webMeta.lastBackupReminderAt = null;
      saveWebMeta(state.webMeta);
    } else {
      saveLastBackupAt(now);
      saveLocalEditCount(0);
      saveLocalBackupReminder(0);
    }
    renderBackupStatus();
  });

  if (els.exportSqlite) {
    els.exportSqlite.addEventListener("click", async () => {
      if (AJL_WEB_MODE) {
        showToast("SQLite export is available in the local app only.");
        return;
      }
      try {
        const res = await fetch("/api/export/sqlite");
        if (!res.ok) throw new Error("SQLite export failed.");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "au_jour_le_jour.sqlite";
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        showToast("Exported SQLite database.");
      } catch (err) {
        showToast("SQLite export failed.");
      }
    });
  }

  if (els.importPick && els.importBackup) {
    els.importPick.addEventListener("click", () => {
      els.importBackup.click();
    });
  }

  if (els.importBackup) {
    els.importBackup.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      await handleImportFile(file);
      event.target.value = "";
    });
  }

  if (els.wizardImport && els.wizardFile) {
    els.wizardImport.addEventListener("click", () => {
      els.wizardFile.click();
    });
    els.wizardFile.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      await handleImportFile(file);
      closeWizard();
      state.view = "setup";
      renderView();
      els.backupSection?.scrollIntoView({ behavior: "smooth", block: "start" });
      event.target.value = "";
    });
  }

  if (els.wizardTemplate) {
    els.wizardTemplate.addEventListener("click", () => {
      closeWizard();
      state.view = "setup";
      renderView();
      els.templateForm?.scrollIntoView({ behavior: "smooth", block: "start" });
      els.templateName?.focus();
    });
  }

  if (els.wizardSkip) {
    els.wizardSkip.addEventListener("click", () => {
      setOnboardingComplete(true);
      closeWizard();
      renderSetupCta();
    });
  }

  if (els.ctaImport && els.importBackup) {
    els.ctaImport.addEventListener("click", () => {
      els.importBackup.click();
    });
  }

  if (els.ctaTemplate) {
    els.ctaTemplate.addEventListener("click", () => {
      state.view = "setup";
      renderView();
      els.templateForm?.scrollIntoView({ behavior: "smooth", block: "start" });
      els.templateName?.focus();
    });
  }

  if (els.firstVisitImport && els.importBackup) {
    els.firstVisitImport.addEventListener("click", () => {
      els.importBackup.click();
    });
  }

  if (els.firstVisitTemplate) {
    els.firstVisitTemplate.addEventListener("click", () => {
      state.view = "setup";
      renderView();
      els.templateForm?.scrollIntoView({ behavior: "smooth", block: "start" });
      els.templateName?.focus();
    });
  }

  if (els.firstVisitContinue) {
    els.firstVisitContinue.addEventListener("click", async () => {
      await setOnboardingComplete(true);
      renderDashboard();
    });
  }

  if (els.backupDrop) {
    ["dragenter", "dragover"].forEach((evt) => {
      els.backupDrop.addEventListener(evt, (event) => {
        event.preventDefault();
        els.backupDrop.classList.add("drag");
      });
    });
    ["dragleave", "drop"].forEach((evt) => {
      els.backupDrop.addEventListener(evt, (event) => {
        event.preventDefault();
        els.backupDrop.classList.remove("drag");
      });
    });
    els.backupDrop.addEventListener("drop", (event) => {
      const file = event.dataTransfer?.files?.[0];
      handleImportFile(file);
    });
  }

  if (els.importModeChips) {
    els.importModeChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const mode = chip.dataset.mode || "merge";
        setImportMode(mode);
      });
    });
  }

  if (els.importConfirm) {
    els.importConfirm.addEventListener("click", () => {
      applyImport();
    });
  }

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

  if (els.resetLocalInline) {
    els.resetLocalInline.addEventListener("click", async () => {
      const confirmed = window.confirm("Reset all local data in this browser? This cannot be undone.");
      if (!confirmed) return;
      await fetch("/api/reset-local", { method: "POST" });
      if (AJL_WEB_MODE) {
        try {
          localStorage.removeItem(WEB_META_KEY);
          localStorage.removeItem(BACKUP_LAST_KEY);
          localStorage.removeItem(LOCAL_EDIT_COUNT_KEY);
          localStorage.removeItem(LOCAL_BACKUP_REMINDER_KEY);
          localStorage.removeItem(JANITOR_RUNTIME_BASE_KEY);
          localStorage.removeItem(JANITOR_RUNTIME_REQUIRED_KEY);
        } catch (err) {
          // ignore
        }
      }
      window.location.reload();
    });
  }

  if (els.clearFilters) {
    els.clearFilters.addEventListener("click", () => {
      state.filters = { search: "", status: "all", category: "all", sort: "due_date", preset: "none" };
      if (els.searchInput) els.searchInput.value = "";
      if (els.categoryFilter) els.categoryFilter.value = "all";
      if (els.sortFilter) els.sortFilter.value = "due_date";
      if (els.statusChips) {
        els.statusChips.forEach((chip) => {
          chip.classList.toggle("active", chip.dataset.status === "all");
        });
      }
      if (els.presetChips) {
        els.presetChips.forEach((chip) => {
          chip.classList.toggle("active", false);
        });
      }
      renderDashboard();
    });
  }

  if (els.startSafeMode) {
    els.startSafeMode.addEventListener("click", () => {
      const url = new URL(window.location.href);
      url.searchParams.set("safe", "1");
      window.location.href = url.toString();
    });
  }

  if (els.previewReadonly) {
    els.previewReadonly.addEventListener("change", () => {
      const enabled = !!els.previewReadonly.checked;
      if (AJL_WEB_MODE && state.webMeta) {
        state.webMeta.readOnlyPreview = enabled;
        saveWebMeta(state.webMeta);
      }
      applyReadOnlyPreview(enabled);
      renderDashboard();
    });
  }

  if (els.searchInput) {
    let searchTimer = null;
    els.searchInput.addEventListener("input", () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.filters.search = els.searchInput.value.trim();
        renderDashboard();
      }, 250);
    });
  }

  if (els.presetChips) {
    els.presetChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const preset = chip.dataset.preset || "none";
        const next = state.filters.preset === preset ? "none" : preset;
        state.filters.preset = next;
        els.presetChips.forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.preset === next);
        });
        renderDashboard();
      });
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

  if (els.reviewExport) {
    els.reviewExport.addEventListener("click", () => {
      exportReviewCsv();
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

  if (els.assistantProviderSelect) {
    els.assistantProviderSelect.addEventListener("change", () => {
      renderAssistantConnection();
    });
  }

  if (els.assistantProviderKey) {
    els.assistantProviderKey.addEventListener("input", () => {
      renderAssistantConnection();
    });
  }

  if (els.assistantProviderConnect) {
    els.assistantProviderConnect.addEventListener("click", async () => {
      await connectMamdouFromAssistant();
    });
  }

  if (els.assistantProviderSetup) {
    els.assistantProviderSetup.addEventListener("click", () => {
      openSetupAgentSection();
      if (els.setupAgentProvider && els.assistantProviderSelect) {
        const provider =
          normalizeMamdouProviderInput(els.assistantProviderSelect.value || "") || "qwen-oauth";
        els.setupAgentProvider.value = provider;
      }
      renderSetupAgentConnection();
    });
  }

  if (els.lanCopy) {
    els.lanCopy.addEventListener("click", async () => {
      const text = els.lanUrl?.textContent?.trim();
      if (!text || text === "—") return;
      try {
        await navigator.clipboard.writeText(text);
        showToast("LAN URL copied.");
      } catch (err) {
        showToast("Unable to copy LAN URL.");
      }
    });
  }

  if (els.setupAgentStart) {
    els.setupAgentStart.addEventListener("click", async () => {
      await startQwenAuth();
      renderSetupAgentConnection();
    });
  }

  if (els.setupAgentProvider) {
    els.setupAgentProvider.addEventListener("change", () => {
      const provider = String(els.setupAgentProvider.value || "qwen-oauth").toLowerCase();
      const providerState = state.llmProviders?.providers?.[provider] || {};
      if (els.setupAgentModel) {
        els.setupAgentModel.value = String(providerState.model || defaultModelForProvider(provider));
      }
      if (els.setupAgentBase) {
        els.setupAgentBase.value = String(providerState.base_url || "");
      }
      if (els.setupAgentKey) {
        els.setupAgentKey.value = "";
      }
      renderSetupAgentConnection();
    });
  }

  if (els.setupAgentSaveProvider) {
    els.setupAgentSaveProvider.addEventListener("click", async () => {
      await saveLlmProviderSelection();
      await loadQwenAuthStatus();
      renderNudges();
      renderSetupAgentConnection();
    });
  }

  if (els.setupAgentConnectKey) {
    els.setupAgentConnectKey.addEventListener("click", async () => {
      await connectProviderApiKey();
    });
  }

  if (els.setupAgentTest) {
    els.setupAgentTest.addEventListener("click", async () => {
      await testActiveProviderConnection();
    });
  }

  if (els.setupAgentRefresh) {
    els.setupAgentRefresh.addEventListener("click", async () => {
      await loadLlmProviderStatus({ silent: true });
      await loadQwenAuthStatus();
      renderNudges();
      renderSetupAgentConnection();
      showToast("Mamdou connection refreshed.");
    });
  }

  if (els.setupAgentDisconnect) {
    els.setupAgentDisconnect.addEventListener("click", async () => {
      const confirmed = window.confirm("Disconnect Mamdou on this device?");
      if (!confirmed) return;
      const provider = String(els.setupAgentProvider?.value || getActiveProviderName()).toLowerCase();
      const res = await apiFetch(
        `/api/llm/providers/disconnect?provider=${encodeURIComponent(provider)}`,
        { method: "DELETE" },
        { silent: true }
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        showSystemBanner(getErrorMessage(payload, `Unable to disconnect Mamdou (${res.status}).`));
        return;
      }
      stopQwenPolling();
      state.qwenAuth = {
        connected: false,
        status: "disconnected",
        session_id: null,
        verification_uri_complete: null,
        interval_seconds: null,
      };
      state.llmStatus = { status: "unknown", auth_url: null, error: null };
      await loadLlmProviderStatus({ silent: true });
      await loadQwenAuthStatus();
      renderNudges();
      renderSetupAgentConnection();
      showToast("Mamdou disconnected.");
    });
  }

  if (els.diagnosticsRun) {
    els.diagnosticsRun.addEventListener("click", async () => {
      await runDiagnostics({ force: true });
    });
  }

  if (els.diagnosticsClearCache) {
    els.diagnosticsClearCache.addEventListener("click", async () => {
      await clearDiagnosticsCache();
    });
  }

  if (els.diagnosticsCopy) {
    els.diagnosticsCopy.addEventListener("click", async () => {
      const text = String(els.diagnosticsOutput?.textContent || "").trim();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        showToast("Diagnostics copied.");
      } catch (err) {
        showToast("Unable to copy diagnostics.");
      }
    });
  }

  if (els.shannonRun) {
    els.shannonRun.addEventListener("click", async () => {
      await runShannonMode("full");
    });
  }

  if (els.shannonRunLlmRuntime) {
    els.shannonRunLlmRuntime.addEventListener("click", async () => {
      await runShannonMode("llm-runtime");
    });
  }

  if (els.shannonRefresh) {
    els.shannonRefresh.addEventListener("click", async () => {
      await loadShannonStatus({ force: true });
    });
  }

  if (els.shannonCopy) {
    els.shannonCopy.addEventListener("click", async () => {
      await copyShannonOutput();
    });
  }

  if (els.janitorRuntimeBase) {
    els.janitorRuntimeBase.addEventListener("change", () => {
      applyJanitorRuntimeControlUpdate();
    });
  }

  if (els.janitorRuntimeRequired) {
    els.janitorRuntimeRequired.addEventListener("change", () => {
      applyJanitorRuntimeControlUpdate();
    });
  }

  if (els.janitorCopyRepro) {
    els.janitorCopyRepro.addEventListener("click", async () => {
      await copyJanitorRepro();
    });
  }

  if (els.janitorFilterStatus) {
    els.janitorFilterStatus.addEventListener("change", () => applyJanitorFilterUpdate());
  }

  if (els.janitorFilterSeverity) {
    els.janitorFilterSeverity.addEventListener("change", () => applyJanitorFilterUpdate());
  }

  if (els.janitorFilterSuite) {
    els.janitorFilterSuite.addEventListener("change", () => applyJanitorFilterUpdate());
  }

  if (els.janitorSearch) {
    let janitorSearchTimer = null;
    els.janitorSearch.addEventListener("input", () => {
      if (janitorSearchTimer) clearTimeout(janitorSearchTimer);
      janitorSearchTimer = setTimeout(() => applyJanitorFilterUpdate(), 160);
    });
  }

  window.addEventListener("keydown", (event) => {
    const target = event.target;
    const isTyping =
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);
    if (isTyping) return;

    if (event.key === "/" && document.activeElement !== els.searchInput) {
      event.preventDefault();
      els.searchInput?.focus();
      return;
    }

    const detailVisible = state.splitView
      ? !!state.selectedInstanceId
      : els.detailsDrawer && !els.detailsDrawer.classList.contains("hidden");

    if (event.key.toLowerCase() === "d" && detailVisible && state.selectedInstanceId && !state.readOnly) {
      event.preventDefault();
      markPaid(state.selectedInstanceId);
      return;
    }

    if (event.key.toLowerCase() === "e" && detailVisible && els.detailEditName) {
      event.preventDefault();
      els.detailEditName.focus();
      return;
    }

    if (event.key.toLowerCase() === "l" && detailVisible && els.detailLogAmount && !state.readOnly) {
      event.preventDefault();
      els.detailLogAmount.focus();
      return;
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
      recordMutation();
      await setOnboardingComplete(true);
      closeWizard();
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
    recordMutation();
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
      sendLlmAgent("drawer");
    });
  }

  if (els.agentInlineSend) {
    els.agentInlineSend.addEventListener("click", () => {
      sendLlmAgent("inline");
    });
  }

  if (els.agentInlineInput) {
    els.agentInlineInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendLlmAgent("inline");
      }
    });
  }

  if (els.agentInlineOpen && els.assistantDrawer) {
    els.agentInlineOpen.addEventListener("click", () => {
      els.assistantDrawer.classList.remove("hidden");
      focusAgentInput({ scroll: true });
    });
  }

  if (els.agentInlineShortcuts && els.agentInlineShortcuts.length > 0) {
    els.agentInlineShortcuts.forEach((chip) => {
      chip.addEventListener("click", () => {
        const text = String(chip.dataset.agentShortcut || "").trim();
        if (!text || !els.agentInlineInput) return;
        els.agentInlineInput.value = text;
        sendLlmAgent("inline");
      });
    });
  }

  if (els.llmAgentConfirm) {
    els.llmAgentConfirm.addEventListener("click", () => {
      confirmPendingAgentAction();
    });
  }

  if (els.llmAgentCancel) {
    els.llmAgentCancel.addEventListener("click", () => {
      cancelPendingAgentAction();
    });
  }

  if (els.agentInlineConfirm) {
    els.agentInlineConfirm.addEventListener("click", () => {
      confirmPendingAgentAction();
    });
  }

  if (els.agentInlineCancel) {
    els.agentInlineCancel.addEventListener("click", () => {
      cancelPendingAgentAction();
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
        sendLlmAgent("drawer");
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
  const shareToken = getShareTokenFromPath();
  document.body.classList.toggle("web", AJL_WEB_MODE);
  document.body.classList.toggle("local", !AJL_WEB_MODE);
  state.shareOwnerKey = loadShareOwnerKey();
  state.shareOptions = loadShareOptions();
  if (shareToken) {
    state.shareToken = shareToken;
    setReadOnlyMode(true);
    const now = new Date();
    setMonth(now.getFullYear(), now.getMonth() + 1);
    state.view = "today";
    bindEvents();
    renderView();
    await loadSharedView(shareToken);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.readOnly && state.shareToken) {
        loadSharedView(state.shareToken, { silent: true }).catch(() => {});
      }
    });
    return;
  }
  if (await handleResetFlag()) return;
  const now = new Date();
  setMonth(now.getFullYear(), now.getMonth() + 1);
  state.monthLocked = false;
  state.lastAutoMonthKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  state.essentialsOnly = els.essentialsToggle.checked;
  state.profileName = loadProfileName();
  state.shareOwnerLabel = state.profileName || "";
  state.janitorRuntimeBase = loadJanitorRuntimeBase();
  state.janitorRuntimeRequired = loadJanitorRuntimeRequired();
  syncJanitorRuntimeControls();
  if (AJL_WEB_MODE) {
    state.webMeta = loadWebMeta();
    state.lastBackupAt = state.webMeta.lastBackupAt || null;
    if (els.previewReadonly) {
      els.previewReadonly.checked = !!state.webMeta.readOnlyPreview;
    }
  } else {
    state.lastBackupAt = loadLastBackupAt();
  }
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
  loadLanInfo();
  if (AJL_WEB_MODE && state.webMeta?.readOnlyPreview) {
    applyReadOnlyPreview(true);
  }
  loadShareInfo().then((share) => {
    state.shareInfo = share ? normalizeShareInfo(share) : null;
    if (state.shareInfo?.owner_label) {
      state.shareOwnerLabel = state.shareInfo.owner_label;
    }
    scheduleSharePublish();
  });
  if (els.fundMonths && els.fundCadence && els.fundCadence.value !== "custom_months") {
    els.fundMonths.disabled = true;
  }
  if (!AJL_WEB_MODE && els.shannonOutput) {
    loadShannonStatus({ silent: true }).catch(() => {});
  }
  updateSplitView(true);
  window.addEventListener("resize", () => {
    if (splitViewTimer) clearTimeout(splitViewTimer);
    splitViewTimer = setTimeout(() => updateSplitView(), 150);
  });
  window.addEventListener("orientationchange", () => updateSplitView(true));
  if (!scrollShadowBound) {
    scrollShadowBound = true;
    let ticking = false;
    const updateShadow = () => {
      document.body.classList.toggle("scrolled", window.scrollY > 4);
    };
    window.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(() => {
          updateShadow();
          ticking = false;
        });
      },
      { passive: true }
    );
    updateShadow();
  }
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
