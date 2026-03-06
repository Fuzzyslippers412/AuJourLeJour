const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const express = require("express");
const Database = require("better-sqlite3");
const { randomUUID, createHash, randomBytes, createCipheriv, createDecipheriv } = require("crypto");
const ledger = require("./ledger");
const advisor = require("./advisor");
const qwenOauth = require("./qwen_oauth");
const { runMigrations } = require("./migrations");
const { createShareRuntime } = require("./modules/share_runtime");

const APP_VERSION = "1.1.0";
const SCHEMA_VERSION = "2";

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 4567;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const SHARE_RELAY_BASE_URL = String(process.env.SHARE_RELAY_BASE_URL || "").trim().replace(/\/+$/, "");
const SHARE_VIEWER_BASE_URL = String(process.env.SHARE_VIEWER_BASE_URL || "").trim().replace(/\/+$/, "");
const BACKUP_RETENTION_DAYS = Math.max(3, Number(process.env.AJL_BACKUP_RETENTION_DAYS || 30));
const MUTATION_RATE_PER_MIN = Math.max(20, Number(process.env.AJL_MUTATION_RATE_PER_MIN || 240));
const MUTATION_RATE_WINDOW_MS = Math.max(1000, Number(process.env.AJL_MUTATION_RATE_WINDOW_MS || 60000));
const SHARE_LOOKUP_RATE_LIMIT = Math.max(10, Number(process.env.AJL_SHARE_LOOKUP_RATE_LIMIT || 60));
const SHARE_LOOKUP_IP_RATE_LIMIT = Math.max(
  SHARE_LOOKUP_RATE_LIMIT,
  Number(process.env.AJL_SHARE_LOOKUP_IP_RATE_LIMIT || SHARE_LOOKUP_RATE_LIMIT * 2)
);
const SHARE_LOOKUP_WINDOW_MS = Math.max(1000, Number(process.env.AJL_SHARE_LOOKUP_WINDOW_MS || 60000));
const LOCAL_API_KEY = String(process.env.AJL_LOCAL_API_KEY || "").trim();
const LLM_CACHE_TTL_MS = Math.max(0, Number(process.env.AJL_LLM_CACHE_TTL_MS || 15000));
const LLM_ROUTE_TIMEOUT_MS = Math.max(3000, Number(process.env.AJL_LLM_ROUTE_TIMEOUT_MS || 22000));
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.AJL_REQUEST_TIMEOUT_MS || 15000));
const TRUST_PROXY_HEADERS = process.env.AJL_TRUST_PROXY === "1";
const JSON_BODY_LIMIT = String(process.env.AJL_JSON_BODY_LIMIT || "256kb");

const dataDir = process.env.AJL_DATA_DIR || path.join(__dirname, "data");
const dbFile = process.env.AJL_DB_PATH || path.join(dataDir, "au_jour_le_jour.sqlite");
const backupDir = process.env.AJL_BACKUP_DIR || path.join(dataDir, "backups");
const lockFile = process.env.AJL_LOCK_FILE || path.join(dataDir, "server.lock");
const disableLock = process.env.AJL_DISABLE_LOCK === "1";
const janitorFunctionalScriptPath = path.join(__dirname, "scripts", "janitor.js");
const janitorAdversarialScriptPath = path.join(__dirname, "scripts", "janitor_adversarial.js");
const janitorPropertyScriptPath = path.join(__dirname, "scripts", "janitor_property.js");
const janitorHygieneScriptPath = path.join(__dirname, "scripts", "janitor_hygiene.js");
const janitorLlmScriptPath = path.join(__dirname, "scripts", "janitor_llm.js");
const janitorLlmRuntimeScriptPath = path.join(__dirname, "scripts", "janitor_llm_runtime.js");
const janitorFunctionalReportPath = path.join(__dirname, "reports", "janitor-functional.json");
const janitorAdversarialReportPath = path.join(__dirname, "reports", "janitor-security.json");
const janitorPropertyReportPath = path.join(__dirname, "reports", "janitor-property.json");
const janitorHygieneReportPath = path.join(__dirname, "reports", "janitor-hygiene.json");
const janitorLlmReportPath = path.join(__dirname, "reports", "janitor-llm.json");
const janitorLlmRuntimeReportPath = path.join(__dirname, "reports", "janitor-llm-runtime.json");
const SHANNON_MAX_LOG_LINES = 1200;
const OPENAI_DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const ANTHROPIC_DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
const ANTHROPIC_BASE_URL = String(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1")
  .trim()
  .replace(/\/+$/, "");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(backupDir, { recursive: true });

const db = new Database(dbFile);
db.pragma("journal_mode = WAL");

const shareRuntime = createShareRuntime({
  shareViewerBaseUrl: SHARE_VIEWER_BASE_URL,
  publicBaseUrl: PUBLIC_BASE_URL,
  port: PORT,
});

const metrics = {
  started_at: nowIsoLocal(),
  requests_total: 0,
  request_errors: 0,
  mutation_requests: 0,
  mutation_limited: 0,
  actions_replayed: 0,
  actions_conflicted: 0,
  llm_requests: 0,
  llm_errors: 0,
  llm_cache_hits: 0,
  llm_timeouts: 0,
  last_llm_latency_ms: null,
  avg_llm_latency_ms: null,
};
let llmLatencySamples = 0;
const llmCache = new Map();
const shannonState = {
  running: false,
  run_id: null,
  started_at: null,
  finished_at: null,
  exit_code: null,
  pid: null,
  logs: [],
  report: null,
  error: null,
  profile: "full",
  phase: null,
  runtime_base: "",
  runtime_required: false,
};

const providerSecretFile = path.join(dataDir, "provider.secret");

const routeRegistry = [];
const routeSecurityOverrides = new Map();

function routeKey(method, pathValue) {
  return `${String(method || "").toUpperCase()} ${String(pathValue || "")}`;
}

function setRouteSecurityMeta(method, pathValue, meta) {
  routeSecurityOverrides.set(routeKey(method, pathValue), meta || {});
}

function inferRouteSecurityMeta(method, pathValue) {
  const methodUpper = String(method || "").toUpperCase();
  const pathText = String(pathValue || "");
  const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(methodUpper);
  const isShare = pathText.startsWith("/api/shares");
  const isPublicShareRead = methodUpper === "GET" && /^\/api\/shares\/:token$/.test(pathText);
  const isOwnerManagedShare = isShare && !isPublicShareRead;
  const isInternal = pathText.startsWith("/internal/");
  const isApi = pathText.startsWith("/api/");
  return {
    mutation: isMutation,
    auth:
      isPublicShareRead
        ? "share_token"
        : isOwnerManagedShare
          ? "owner"
          : isMutation && (isApi || isInternal)
            ? "local_key"
            : "none",
    csrf_protected: isOwnerManagedShare && isMutation,
    json_body: isMutation && (isApi || isInternal),
    cors: isInternal || pathText.startsWith("/api/v1/") ? "public" : "same-origin",
  };
}

function registerRouteMeta(method, pathValue) {
  if (typeof pathValue !== "string" || !pathValue.startsWith("/")) return;
  const key = routeKey(method, pathValue);
  const merged = {
    method: String(method || "").toUpperCase(),
    path: pathValue,
    ...inferRouteSecurityMeta(method, pathValue),
    ...(routeSecurityOverrides.get(key) || {}),
  };
  routeRegistry.push(merged);
}

const originalRouteFns = {
  get: app.get.bind(app),
  post: app.post.bind(app),
  put: app.put.bind(app),
  patch: app.patch.bind(app),
  delete: app.delete.bind(app),
};

["get", "post", "put", "patch", "delete"].forEach((name) => {
  const original = originalRouteFns[name];
  app[name] = function patchedRoute(pathValue, ...handlers) {
    if (typeof pathValue === "string" && handlers.length > 0) {
      registerRouteMeta(name, pathValue);
    }
    return original(pathValue, ...handlers);
  };
});

function getRouteRegistry() {
  const dedup = new Map();
  routeRegistry.forEach((row) => {
    if (!row || !row.method || !row.path) return;
    dedup.set(routeKey(row.method, row.path), row);
  });
  return Array.from(dedup.values()).sort((a, b) => {
    const byPath = String(a.path).localeCompare(String(b.path));
    if (byPath !== 0) return byPath;
    return String(a.method).localeCompare(String(b.method));
  });
}

function appendShannonLog(source, line) {
  const text = String(line || "").replace(/\r/g, "").trimEnd();
  if (!text) return;
  const entry = {
    at: new Date().toISOString(),
    source: source === "stderr" ? "stderr" : "stdout",
    line: text.slice(0, 4000),
  };
  shannonState.logs.push(entry);
  if (shannonState.logs.length > SHANNON_MAX_LOG_LINES) {
    shannonState.logs.splice(0, shannonState.logs.length - SHANNON_MAX_LOG_LINES);
  }
}

function loadJanitorReportFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

function normalizeJanitorResultRow(row, suite, index) {
  const source = row && typeof row === "object" ? row : {};
  const title = String(source.title || source.name || `Check ${Number(index) + 1}`);
  return {
    id: String(source.id || `${suite}_${Number(index) + 1}`),
    suite,
    title,
    name: title,
    severity: source.severity || (suite === "adversarial" ? "HIGH" : "MEDIUM"),
    status: String(source.status || "unknown"),
    attack: source.attack || title,
    expected: source.expected || null,
    actual: source.actual || (source.error ? String(source.error) : null),
    error: source.error || null,
    request: source.request || null,
    response_meta: source.response_meta || null,
    repro_curl: source.repro_curl || "",
    seed: source.seed || null,
  };
}

function normalizeJanitorReport(report, suite) {
  if (!report || typeof report !== "object") return null;
  const summary = report.summary && typeof report.summary === "object" ? report.summary : {};
  const rawResults = Array.isArray(report.results) ? report.results : [];
  return {
    profile: String(report.profile || `janitor-${suite}`),
    generated_at: report.generated_at || null,
    summary: {
      total: Number(summary.total || rawResults.length || 0),
      passed: Number(summary.passed || 0),
      failed: Number(summary.failed || 0),
      skipped: Number(summary.skipped || 0),
      duration_ms: Number(summary.duration_ms || 0),
      by_severity: summary.by_severity || null,
    },
    results: rawResults.map((row, idx) => normalizeJanitorResultRow(row, suite, idx)),
  };
}

function buildJanitorCombinedReport(profile) {
  const suiteDefs = [
    { name: "functional", reportPath: janitorFunctionalReportPath },
    { name: "adversarial", reportPath: janitorAdversarialReportPath },
    { name: "property", reportPath: janitorPropertyReportPath },
    { name: "hygiene", reportPath: janitorHygieneReportPath },
    { name: "llm", reportPath: janitorLlmReportPath },
    { name: "llm-runtime", reportPath: janitorLlmRuntimeReportPath },
  ];
  const reports = suiteDefs
    .map((suite) => ({
      ...suite,
      report: normalizeJanitorReport(loadJanitorReportFile(suite.reportPath), suite.name),
    }))
    .filter((entry) => entry.report);

  if (reports.length === 0) return null;
  const byName = new Map(reports.map((entry) => [entry.name, entry.report]));
  if (profile && profile !== "full") {
    const exact = byName.get(profile);
    if (exact) return exact;
  }

  if (profile === "adversarial" && byName.get("adversarial")) {
    return byName.get("adversarial");
  }

  const summaryByProfile = {};
  const suites = {};
  const severityTotals = {};
  let total = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let durationMs = 0;
  const results = [];
  reports.forEach(({ name, report }) => {
    const summary = report.summary || {};
    summaryByProfile[name] = summary;
    suites[name] = summary;
    total += Number(summary.total || 0);
    passed += Number(summary.passed || 0);
    failed += Number(summary.failed || 0);
    skipped += Number(summary.skipped || 0);
    durationMs += Number(summary.duration_ms || 0);
    if (summary.by_severity && typeof summary.by_severity === "object") {
      Object.entries(summary.by_severity).forEach(([severity, count]) => {
        severityTotals[severity] = Number(severityTotals[severity] || 0) + Number(count || 0);
      });
    }
    if (Array.isArray(report.results)) {
      results.push(...report.results);
    }
  });

  return {
    profile: "janitor-full",
    generated_at: nowIso(),
    summary: {
      total,
      passed,
      failed,
      skipped,
      duration_ms: durationMs,
      by_profile: summaryByProfile,
      by_severity: Object.keys(severityTotals).length ? severityTotals : null,
    },
    suites,
    results,
  };
}

function getShannonStatusPayload() {
  const report = shannonState.running
    ? null
    : shannonState.report || buildJanitorCombinedReport(shannonState.profile || "full");
  return {
    running: !!shannonState.running,
    run_id: shannonState.run_id || null,
    started_at: shannonState.started_at || null,
    finished_at: shannonState.finished_at || null,
    exit_code: shannonState.exit_code,
    pid: shannonState.pid || null,
    error: shannonState.error || null,
    profile: shannonState.profile || "full",
    phase: shannonState.phase || null,
    runtime_base: shannonState.runtime_base || null,
    runtime_required: !!shannonState.runtime_required,
    report_paths: {
      functional: janitorFunctionalReportPath,
      adversarial: janitorAdversarialReportPath,
      property: janitorPropertyReportPath,
      hygiene: janitorHygieneReportPath,
      llm: janitorLlmReportPath,
      "llm-runtime": janitorLlmRuntimeReportPath,
    },
    report:
      report && typeof report === "object"
        ? {
            profile: report.profile || null,
            generated_at: report.generated_at || null,
            summary: report.summary || null,
          }
        : null,
    log_lines: shannonState.logs.length,
    logs_tail: shannonState.logs.slice(-250),
  };
}

function ensureSingleInstance() {
  try {
    if (fs.existsSync(lockFile)) {
      const raw = fs.readFileSync(lockFile, "utf8");
      const prev = JSON.parse(raw);
      const prevPid = Number(prev?.pid);
      if (Number.isInteger(prevPid) && prevPid !== process.pid) {
        try {
          process.kill(prevPid, 0);
          process.kill(prevPid, "SIGTERM");
        } catch (err) {
          // ignore if not running
        }
      }
    }
  } catch (err) {
    // ignore lock read errors
  }

  try {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })
    );
  } catch (err) {
    // ignore lock write errors
  }

  const cleanup = () => {
    try {
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    } catch (err) {
      // ignore
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

function createSchemaV2() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      amount_default REAL NOT NULL,
      due_day INTEGER NOT NULL,
      autopay INTEGER NOT NULL DEFAULT 0,
      essential INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      default_note TEXT,
      match_payee_key TEXT,
      match_amount_tolerance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      name_snapshot TEXT NOT NULL,
      category_snapshot TEXT,
      amount REAL NOT NULL,
      due_date TEXT NOT NULL,
      autopay_snapshot INTEGER NOT NULL,
      essential_snapshot INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','paid','skipped')),
      paid_date TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(template_id, year, month)
    );

    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      amount REAL NOT NULL,
      paid_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payment_instance ON payment_events (instance_id);
    CREATE INDEX IF NOT EXISTS idx_payment_date ON payment_events (paid_date);

    CREATE TABLE IF NOT EXISTS instance_events (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      type TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_instance_events_instance ON instance_events (instance_id);
    CREATE INDEX IF NOT EXISTS idx_instance_events_created ON instance_events (created_at);

    CREATE TABLE IF NOT EXISTS month_settings (
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      cash_start REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (year, month)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_instances_month ON instances (year, month);
    CREATE INDEX IF NOT EXISTS idx_instances_due_status ON instances (due_date, status);

    CREATE TABLE IF NOT EXISTS sinking_funds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      target_amount REAL NOT NULL,
      due_date TEXT NOT NULL,
      cadence TEXT NOT NULL,
      months_per_cycle INTEGER NOT NULL,
      essential INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      auto_contribute INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sinking_events (
      id TEXT PRIMARY KEY,
      fund_id TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('CONTRIBUTION','WITHDRAWAL','ADJUSTMENT')),
      event_date TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      payload TEXT,
      payload_version TEXT,
      owner_label TEXT,
      expires_at TEXT,
      last_published_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sinking_fund ON sinking_events (fund_id);
    CREATE INDEX IF NOT EXISTS idx_sinking_event_date ON sinking_events (event_date);

    CREATE TABLE IF NOT EXISTS oauth_device_sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      device_code TEXT NOT NULL,
      user_code TEXT,
      verification_uri TEXT,
      verification_uri_complete TEXT,
      code_verifier TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_command_log (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      user_text TEXT,
      kind TEXT NOT NULL,
      summary TEXT,
      payload TEXT,
      result TEXT,
      status TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_log_created ON agent_command_log (created_at);

    CREATE TABLE IF NOT EXISTS assistant_chat (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      meta TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_chat_created ON assistant_chat (created_at);
  `);
}

function ensureActionsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT
    );
  `);
}

function ensurePaymentsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      amount REAL NOT NULL,
      paid_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payment_instance ON payment_events (instance_id);
    CREATE INDEX IF NOT EXISTS idx_payment_date ON payment_events (paid_date);
  `);
}

function ensureInstanceEventsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_events (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      type TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_instance_events_instance ON instance_events (instance_id);
    CREATE INDEX IF NOT EXISTS idx_instance_events_created ON instance_events (created_at);
  `);
}

function ensureMonthSettingsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS month_settings (
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      cash_start REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (year, month)
    );
  `);
}

function ensureMetaTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function ensureSinkingTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sinking_funds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      target_amount REAL NOT NULL,
      due_date TEXT NOT NULL,
      cadence TEXT NOT NULL,
      months_per_cycle INTEGER NOT NULL,
      essential INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      auto_contribute INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sinking_events (
      id TEXT PRIMARY KEY,
      fund_id TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('CONTRIBUTION','WITHDRAWAL','ADJUSTMENT')),
      event_date TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sinking_fund ON sinking_events (fund_id);
    CREATE INDEX IF NOT EXISTS idx_sinking_event_date ON sinking_events (event_date);

    CREATE TABLE IF NOT EXISTS oauth_device_sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      device_code TEXT NOT NULL,
      user_code TEXT,
      verification_uri TEXT,
      verification_uri_complete TEXT,
      code_verifier TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function ensureSharesTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      token TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      payload TEXT,
      payload_version TEXT,
      owner_label TEXT,
      expires_at TEXT,
      last_published_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function ensureAssistantTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_command_log (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      user_text TEXT,
      kind TEXT NOT NULL,
      summary TEXT,
      payload TEXT,
      result TEXT,
      status TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_log_created ON agent_command_log (created_at);

    CREATE TABLE IF NOT EXISTS assistant_chat (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      meta TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_assistant_chat_created ON assistant_chat (created_at);
  `);
}

function getTableInfo(name) {
  return db.prepare(`PRAGMA table_info(${name})`).all();
}

function hasColumn(info, name) {
  return info.some((col) => col.name === name);
}

function getMeta(key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    key,
    value
  );
}

function getMetaJson(key) {
  const raw = getMeta(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function setMetaJson(key, value) {
  setMeta(key, JSON.stringify(value));
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  return raw.split(";").reduce((acc, part) => {
    const [key, ...rest] = part.trim().split("=");
    if (!key) return acc;
    const valueRaw = rest.join("=");
    try {
      acc[key] = decodeURIComponent(valueRaw);
    } catch (err) {
      // Never throw from cookie parsing on malformed values.
      acc[key] = valueRaw;
    }
    return acc;
  }, {});
}

function getOwnerSecret() {
  const existing = getMeta("share_owner_secret");
  if (existing) return existing;
  const secret = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  setMeta("share_owner_secret", secret);
  return secret;
}

function ensureOwnerCookie(req, res) {
  const cookies = parseCookies(req);
  if (cookies.ajl_owner) return;
  const secret = getOwnerSecret();
  const secureFlag = req.secure || req.headers["x-forwarded-proto"] === "https";
  const secure = secureFlag ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `ajl_owner=${encodeURIComponent(secret)}; Path=/; SameSite=Strict; HttpOnly${secure}`
  );
}

function extractRequestOrigin(req) {
  const originRaw = String(req.headers.origin || "").trim();
  if (originRaw) return originRaw;
  const refererRaw = String(req.headers.referer || "").trim();
  if (!refererRaw) return "";
  try {
    const parsed = new URL(refererRaw);
    return parsed.origin;
  } catch (err) {
    return "";
  }
}

function getRequestHostOrigin(req) {
  const proto = String(
    req.headers["x-forwarded-proto"] ||
      (req.secure ? "https" : req.protocol || "http")
  )
    .split(",")[0]
    .trim()
    .toLowerCase();
  const host = String(req.headers.host || "").trim();
  if (!host) return "";
  return `${proto}://${host}`;
}

function isPrivateIpv4Host(hostname) {
  const text = String(hostname || "").trim();
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isLocalRuntimeHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "::1") return true;
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (unwrapped === "::1") return true;
  if (isPrivateIpv4Host(unwrapped)) return true;
  return false;
}

function resolveJanitorRuntimeBase(req, rawValue) {
  const fallback = `http://127.0.0.1:${PORT}`;
  const text = String(rawValue || "").trim();
  if (!text) return { ok: true, value: fallback };
  let parsed;
  try {
    parsed = new URL(text);
  } catch (err) {
    return { ok: false, error: "runtime_base must be a valid absolute URL." };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "runtime_base must use http or https." };
  }
  const host = String(parsed.hostname || "").toLowerCase();
  const requestOrigin = getRequestHostOrigin(req);
  let requestHost = "";
  if (requestOrigin) {
    try {
      requestHost = String(new URL(requestOrigin).hostname || "").toLowerCase();
    } catch (err) {
      requestHost = "";
    }
  }
  if (!isLocalRuntimeHost(host) && (!requestHost || host !== requestHost)) {
    return { ok: false, error: "runtime_base host must be localhost, private IP, or current host." };
  }
  return { ok: true, value: `${parsed.protocol}//${parsed.host}` };
}

function isAllowedSameOriginRequest(req) {
  const requestOrigin = extractRequestOrigin(req);
  if (!requestOrigin) return true;
  const hostOrigin = getRequestHostOrigin(req);
  if (!hostOrigin) return true;
  return requestOrigin === hostOrigin;
}

function requireOwner(req, res) {
  const secret = getOwnerSecret();
  const rawHeader = req.headers["x-ajl-share-owner"];
  if (Array.isArray(rawHeader)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  const headerSecret = String(rawHeader || "").trim();
  if (headerSecret.includes(",") || /\s/.test(headerSecret)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (headerSecret && headerSecret === secret) {
    return true;
  }
  const cookies = parseCookies(req);
  if (!cookies.ajl_owner || cookies.ajl_owner !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function hasValidOwnerCookie(req) {
  const cookies = parseCookies(req);
  const secret = getOwnerSecret();
  return !!cookies.ajl_owner && cookies.ajl_owner === secret;
}

function generateShareToken() {
  return require("crypto").randomBytes(24).toString("base64url");
}

function isValidShareToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{24,128}$/.test(token);
}

const MAX_SHARE_ITEMS = 3000;
const MAX_SHARE_PAYLOAD_BYTES = 2_000_000;
const SHARE_STATUS_VALUES = new Set(["pending", "partial", "paid", "skipped"]);

function sanitizeOwnerLabel(value) {
  if (value === undefined || value === null) return null;
  const clean = String(value).trim();
  if (!clean) return null;
  return clean.slice(0, 120);
}

function parseShareExpiresAt(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === "") return { ok: true, value: null };
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: "Invalid expires_at" };
  }
  if (parsed.getTime() <= Date.now()) {
    return { ok: false, error: "expires_at must be in the future" };
  }
  return { ok: true, value: parsed.toISOString() };
}

function isExpiredIso(iso) {
  if (!iso) return false;
  const ts = new Date(String(iso)).getTime();
  if (!Number.isFinite(ts)) return false;
  return ts <= Date.now();
}

function expireStaleShares() {
  const now = nowIso();
  db.prepare(
    "UPDATE shares SET is_active = 0, updated_at = ? WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at <= ?"
  ).run(now, now);
}

function pruneOauthDeviceSessions() {
  const cutoffIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `DELETE FROM oauth_device_sessions
     WHERE status IN ('approved','expired','error','superseded')
       AND created_at < ?`
  ).run(cutoffIso);
}

function validateSharePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Invalid payload" };
  }
  if (!Array.isArray(payload.items)) {
    return { ok: false, error: "Invalid payload" };
  }
  if (payload.items.length > MAX_SHARE_ITEMS) {
    return { ok: false, error: `Too many items (max ${MAX_SHARE_ITEMS})` };
  }
  if (payload.period && !/^\d{4}-\d{2}$/.test(String(payload.period))) {
    return { ok: false, error: "Invalid period format" };
  }
  if (payload.schema_version !== undefined) {
    const sv = String(payload.schema_version);
    if (sv !== "1") {
      return { ok: false, error: "Unsupported payload schema_version" };
    }
  }
  for (const item of payload.items) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "Invalid payload item" };
    }
    if (!item.id || typeof item.id !== "string") {
      return { ok: false, error: "Invalid payload item id" };
    }
    if (!item.name_snapshot || typeof item.name_snapshot !== "string") {
      return { ok: false, error: "Invalid payload item name" };
    }
    if (!item.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.due_date))) {
      return { ok: false, error: "Invalid payload item due_date" };
    }
    if (item.status && !SHARE_STATUS_VALUES.has(String(item.status))) {
      return { ok: false, error: "Invalid payload item status" };
    }
  }
  return { ok: true };
}

function parseSharePublishYearMonth(body) {
  const now = new Date();
  const fallback = { year: now.getFullYear(), month: now.getMonth() + 1 };
  if (!body || typeof body !== "object") return fallback;
  if (body.year === undefined && body.month === undefined) return fallback;
  const year = Number(body.year);
  const month = Number(body.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

function buildSharePayloadFromMonth(year, month, options = {}) {
  ensureMonth(year, month);
  const includeAmounts = options.includeAmounts !== false;
  const includeNotes = options.includeNotes !== false;
  const includeCategories = options.includeCategories !== false;
  const ownerLabel = sanitizeOwnerLabel(options.ownerLabel);
  const settings = getMetaJson("settings") || {};
  const categories = includeCategories && Array.isArray(settings.categories) ? settings.categories : [];
  const items = getInstances(year, month);
  return {
    schema_version: "1",
    period: `${year}-${ledger.pad2(month)}`,
    owner_label: ownerLabel,
    generated_at: nowIso(),
    privacy: {
      include_amounts: includeAmounts,
      include_notes: includeNotes,
      include_categories: includeCategories,
    },
    items: items.map((item) => ({
      id: item.id,
      template_id: item.template_id,
      year: item.year,
      month: item.month,
      name_snapshot: item.name_snapshot,
      category_snapshot: includeCategories ? item.category_snapshot || null : null,
      amount: includeAmounts ? Number(item.amount || 0) : null,
      due_date: item.due_date,
      status: item.status_derived || item.status || "pending",
      paid_date: item.paid_date || null,
      amount_paid: includeAmounts ? Number(item.amount_paid || 0) : null,
      amount_remaining: includeAmounts ? Number(item.amount_remaining || 0) : null,
      essential_snapshot: !!item.essential_snapshot,
      autopay_snapshot: !!item.autopay_snapshot,
      note: includeNotes ? item.note || null : null,
    })),
    categories,
  };
}

function computeShareEtag(row) {
  const raw = [
    String(row?.token || ""),
    String(row?.updated_at || ""),
    String(row?.payload_version || ""),
    String(row?.last_published_at || ""),
    String(row?.mode || ""),
    String(row?.is_active || 0),
  ].join("|");
  const hash = createHash("sha1").update(raw).digest("hex");
  return `"${hash}"`;
}

function buildViewerShareUrl(req, token) {
  return shareRuntime.buildViewerShareUrl(req, token);
}

function getViewerBaseUrl(req) {
  return shareRuntime.getViewerBaseUrl(req);
}

const shareLookupByActor = new Map();
const shareLookupByIp = new Map();

function pruneRateMap(map, nowTs) {
  if (map.size < 1000) return;
  for (const [key, entry] of map.entries()) {
    if (!entry || typeof entry.ts !== "number" || nowTs - entry.ts > 5 * 60 * 1000) {
      map.delete(key);
    }
  }
}

function consumeWindowedBucket(map, key, limit, windowMs, nowTs) {
  const entry = map.get(key) || { count: 0, ts: nowTs };
  if (nowTs - entry.ts > windowMs) {
    entry.count = 0;
    entry.ts = nowTs;
  }
  entry.count += 1;
  map.set(key, entry);
  if (entry.count <= limit) {
    return { limited: false, retryAfterSec: 0 };
  }
  const retryAfterSec = Math.max(1, Math.ceil((windowMs - (nowTs - entry.ts)) / 1000));
  return { limited: true, retryAfterSec };
}

function rateLimitShareLookup(req, res) {
  const ip = extractClientIp(req);
  const token = String(req.params?.token || req.path || "").slice(0, 64);
  const actorKey = `${ip}|${token}`;
  const now = Date.now();
  pruneRateMap(shareLookupByActor, now);
  pruneRateMap(shareLookupByIp, now);

  const actorLimit = consumeWindowedBucket(
    shareLookupByActor,
    actorKey,
    SHARE_LOOKUP_RATE_LIMIT,
    SHARE_LOOKUP_WINDOW_MS,
    now
  );
  const ipLimit = consumeWindowedBucket(
    shareLookupByIp,
    ip,
    SHARE_LOOKUP_IP_RATE_LIMIT,
    SHARE_LOOKUP_WINDOW_MS,
    now
  );

  if (actorLimit.limited || ipLimit.limited) {
    const retryAfterSec = Math.max(actorLimit.retryAfterSec, ipLimit.retryAfterSec, 1);
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({ error: "Too many requests" });
    return false;
  }
  return true;
}

function initSchema() {
  const hasTemplates = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='templates'")
    .get();
  const hasInstances = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='instances'")
    .get();

  if (!hasTemplates || !hasInstances) {
    createSchemaV2();
    ensureActionsTable();
    ensurePaymentsTable();
    ensureInstanceEventsTable();
    ensureMonthSettingsTable();
    ensureMetaTable();
    ensureSinkingTables();
    ensureSharesTable();
    ensureAssistantTables();
    return;
  }

  const templateInfo = getTableInfo("templates");
  const instanceInfo = getTableInfo("instances");
  const templateId = templateInfo.find((col) => col.name === "id");
  const instanceId = instanceInfo.find((col) => col.name === "id");
  const instanceTemplate = instanceInfo.find((col) => col.name === "template_id");

  const isV2 =
    templateId &&
    /TEXT/i.test(templateId.type || "") &&
    instanceId &&
    /TEXT/i.test(instanceId.type || "") &&
    instanceTemplate &&
    /TEXT/i.test(instanceTemplate.type || "");

  if (!isV2) {
    migrateLegacySchema();
  }

  const refreshedTemplateInfo = getTableInfo("templates");
  if (!hasColumn(refreshedTemplateInfo, "match_payee_key")) {
    db.exec("ALTER TABLE templates ADD COLUMN match_payee_key TEXT");
  }
  if (!hasColumn(refreshedTemplateInfo, "match_amount_tolerance")) {
    db.exec(
      "ALTER TABLE templates ADD COLUMN match_amount_tolerance REAL NOT NULL DEFAULT 0"
    );
  }

  ensureActionsTable();
  ensurePaymentsTable();
  ensureInstanceEventsTable();
  ensureMonthSettingsTable();
  ensureMetaTable();
  ensureSinkingTables();
  ensureSharesTable();
  ensureAssistantTables();
}

function migrateLegacySchema() {
  const suffix = Date.now();
  const legacyTemplates = `templates_legacy_${suffix}`;
  const legacyInstances = `instances_legacy_${suffix}`;

  db.exec(`ALTER TABLE templates RENAME TO ${legacyTemplates};`);
  db.exec(`ALTER TABLE instances RENAME TO ${legacyInstances};`);

  createSchemaV2();
  ensureActionsTable();
  ensurePaymentsTable();
  ensureInstanceEventsTable();
  ensureMonthSettingsTable();
  ensureMetaTable();
  ensureSinkingTables();
  ensureSharesTable();
  ensureAssistantTables();

  const legacyTemplateRows = db
    .prepare(`SELECT * FROM ${legacyTemplates}`)
    .all();
  const legacyInstanceRows = db
    .prepare(`SELECT * FROM ${legacyInstances}`)
    .all();

  const templateIdMap = new Map();
  const insertTemplate = db.prepare(
    `INSERT INTO templates (
      id, name, category, amount_default, due_day, autopay, essential, active, default_note,
      match_payee_key, match_amount_tolerance, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertInstance = db.prepare(
    `INSERT INTO instances (
      id, template_id, year, month, name_snapshot, category_snapshot, amount, due_date,
      autopay_snapshot, essential_snapshot, status, paid_date, note, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const run = db.transaction(() => {
    for (const tmpl of legacyTemplateRows) {
      const newId = randomUUID();
      templateIdMap.set(tmpl.id, newId);
      insertTemplate.run(
        newId,
        tmpl.name,
        tmpl.category || null,
        tmpl.amount_default,
        tmpl.due_day,
        tmpl.autopay ? 1 : 0,
        tmpl.essential ? 1 : 0,
        tmpl.active ? 1 : 0,
        tmpl.default_note || null,
        null,
        0,
        tmpl.created_at || nowIso(),
        tmpl.updated_at || nowIso()
      );
    }

    for (const inst of legacyInstanceRows) {
      const mappedTemplateId = templateIdMap.get(inst.template_id);
      if (!mappedTemplateId) continue;
      insertInstance.run(
        randomUUID(),
        mappedTemplateId,
        inst.year,
        inst.month,
        inst.name_snapshot,
        inst.category_snapshot || null,
        inst.amount,
        inst.due_date,
        inst.autopay_snapshot ? 1 : 0,
        inst.essential_snapshot ? 1 : 0,
        inst.status,
        inst.paid_date || null,
        inst.note || null,
        inst.created_at || nowIso(),
        inst.updated_at || nowIso()
      );
    }
  });

  run();
  autoContributeForMonth(year, month);
}

function migrateLegacyPayments() {
  ensurePaymentsTable();
  ensureMetaTable();
  const marker = getMeta("payments_migrated_v1");
  if (marker) return;

  const paidRows = db
    .prepare("SELECT id, amount, paid_date, updated_at, status FROM instances WHERE status = 'paid'")
    .all();

  if (paidRows.length === 0) {
    setMeta("payments_migrated_v1", nowIso());
    return;
  }

  const insertPayment = db.prepare(
    `INSERT INTO payment_events (id, instance_id, amount, paid_date, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );

  const run = db.transaction(() => {
    for (const row of paidRows) {
      const paidDate = row.paid_date || (row.updated_at || nowIso()).slice(0, 10);
      insertPayment.run(
        randomUUID(),
        row.id,
        Number(row.amount || 0),
        paidDate,
        row.updated_at || nowIso()
      );
    }
    setMeta("payments_migrated_v1", nowIso());
  });

  run();
}

initSchema();
runMigrations(db, nowIso);
migrateLegacyPayments();
ensureDailyBackup();
pruneOauthDeviceSessions();

app.use((req, res, next) => {
  req.setTimeout(REQUEST_TIMEOUT_MS);
  res.setTimeout(REQUEST_TIMEOUT_MS);
  next();
});

app.use((req, res, next) => {
  const hasTransferEncoding = req.headers["transfer-encoding"] !== undefined;
  const hasContentLength = req.headers["content-length"] !== undefined;
  if (hasTransferEncoding && hasContentLength) {
    return res.status(400).json({
      error: { code: "BAD_REQUEST", message: "Conflicting Transfer-Encoding and Content-Length." },
    });
  }
  next();
});

app.use((req, res, next) => {
  const hasMethodOverrideHeader = req.headers["x-http-method-override"] !== undefined;
  const hasMethodOverrideQuery = req.query && req.query._method !== undefined;
  if (hasMethodOverrideHeader || hasMethodOverrideQuery) {
    return res.status(400).json({
      error: { code: "METHOD_OVERRIDE_NOT_ALLOWED", message: "HTTP method override is not allowed." },
    });
  }
  next();
});

app.use((req, res, next) => {
  const isApiLike = req.path.startsWith("/api/") || req.path.startsWith("/internal/");
  const needsJsonType = ["POST", "PUT", "PATCH"].includes(req.method) && isApiLike;
  if (!needsJsonType) return next();
  const hasBody =
    Number(req.headers["content-length"] || 0) > 0 || req.headers["transfer-encoding"] !== undefined;
  if (!hasBody) return next();
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return res.status(415).json({
      error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json." },
    });
  }
  next();
});

app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use((req, res, next) => {
  const incoming = String(req.headers["x-request-id"] || "").trim();
  const requestId = incoming || randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
});
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!(req.path.startsWith("/api/") || req.path.startsWith("/internal/"))) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
    );
  }
  next();
});
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/internal/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});
app.use((req, res, next) => {
  metrics.requests_total += 1;
  res.on("finish", () => {
    if (res.statusCode >= 500) metrics.request_errors += 1;
  });
  next();
});
app.use((req, res, next) => {
  if (!isMutationRequest(req)) return next();
  metrics.mutation_requests += 1;
  if (LOCAL_API_KEY) {
    const headerKey = String(req.headers["x-ajl-local-key"] || "").trim();
    const ownerCookieValid = hasValidOwnerCookie(req);
    if (headerKey !== LOCAL_API_KEY && !ownerCookieValid) {
      return res.status(401).json({ error: "Missing or invalid local API key." });
    }
  }
  if (!allowMutationRequest(req, res)) return;
  next();
});
app.use((req, res, next) => {
  const isShareMutation = req.path.startsWith("/api/shares") && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  if (!isShareMutation) return next();
  if (!isAllowedSameOriginRequest(req)) {
    return res.status(403).json({
      error: { code: "CSRF_BLOCKED", message: "Cross-site request blocked." },
    });
  }
  next();
});
app.use((req, res, next) => {
  if (req.path.startsWith("/s/")) return next();
  if (req.path.startsWith("/api/shares/") && req.method === "GET") return next();
  ensureOwnerCookie(req, res);
  next();
});
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/v1", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/internal", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function nowIso() {
  return new Date().toISOString();
}

const mutationRate = new Map();

function normalizeIpForRateLimit(value) {
  const raw = String(value || "").split(",")[0].trim().replace(/^["']+|["']+$/g, "");
  if (!raw) return "";
  if (raw.length > 256) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end > 1) return raw.slice(1, end);
  }
  if (raw.includes(".") && raw.includes(":")) {
    const parts = raw.split(":");
    if (parts.length === 2 && /^\d+$/.test(parts[1])) return parts[0];
  }
  return raw;
}

function extractClientIp(req) {
  const fromForwarded = TRUST_PROXY_HEADERS
    ? normalizeIpForRateLimit(req.headers["x-forwarded-for"])
    : "";
  const fromRemote = normalizeIpForRateLimit(req.socket?.remoteAddress || req.ip || "");
  const selected = fromForwarded || fromRemote || "unknown";
  return selected.slice(0, 128);
}

function pruneMutationRate(nowMs) {
  if (mutationRate.size < 2000) return;
  for (const [ip, entry] of mutationRate.entries()) {
    if (!entry || nowMs - entry.ts > 5 * 60 * 1000) mutationRate.delete(ip);
  }
}

function isMutationRequest(req) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return false;
  if (req.path.startsWith("/api/health")) return false;
  if (req.path.startsWith("/api/lan")) return false;
  if (req.path.startsWith("/api/metrics")) return false;
  return req.path.startsWith("/api/") || req.path.startsWith("/internal/");
}

function allowMutationRequest(req, res) {
  const ip = extractClientIp(req);
  const ownerHeader = String(req.headers["x-ajl-share-owner"] || "").trim().slice(0, 32);
  const actorKey = `${ip}|${ownerHeader}|${req.path}`;
  const nowMs = Date.now();
  pruneMutationRate(nowMs);
  const entry = mutationRate.get(actorKey) || { count: 0, ts: nowMs };
  if (nowMs - entry.ts > MUTATION_RATE_WINDOW_MS) {
    entry.count = 0;
    entry.ts = nowMs;
  }
  entry.count += 1;
  mutationRate.set(actorKey, entry);
  if (entry.count > MUTATION_RATE_PER_MIN) {
    metrics.mutation_limited += 1;
    const retryAfterSec = Math.max(1, Math.ceil((MUTATION_RATE_WINDOW_MS - (nowMs - entry.ts)) / 1000));
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({ error: "Too many mutation requests. Please retry shortly." });
    return false;
  }
  return true;
}

function recordLlmLatency(ms, ok) {
  metrics.llm_requests += 1;
  if (!ok) metrics.llm_errors += 1;
  metrics.last_llm_latency_ms = Math.round(ms);
  llmLatencySamples += 1;
  const prev = Number(metrics.avg_llm_latency_ms || 0);
  const next = llmLatencySamples <= 1 ? ms : prev + (ms - prev) / llmLatencySamples;
  metrics.avg_llm_latency_ms = Math.round(next);
}

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${parts.join(",")}}`;
}

function pruneLlmCache(nowMs) {
  if (llmCache.size === 0) return;
  for (const [key, entry] of llmCache.entries()) {
    if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= nowMs) {
      llmCache.delete(key);
    }
  }
}

function buildLlmCacheKey(task, payload, provider) {
  return `${String(provider || "")}|${String(task || "")}|${stableStringify(payload || {})}`;
}

function getCachedLlmResult(task, payload, provider) {
  if (LLM_CACHE_TTL_MS <= 0) return null;
  const nowMs = Date.now();
  pruneLlmCache(nowMs);
  const key = buildLlmCacheKey(task, payload, provider);
  const entry = llmCache.get(key);
  if (!entry || entry.expiresAt <= nowMs) {
    if (entry) llmCache.delete(key);
    return null;
  }
  metrics.llm_cache_hits += 1;
  return entry.value;
}

function setCachedLlmResult(task, payload, provider, value) {
  if (LLM_CACHE_TTL_MS <= 0 || !value) return;
  if (llmCache.size > 300) {
    pruneLlmCache(Date.now());
    if (llmCache.size > 300) {
      const firstKey = llmCache.keys().next().value;
      if (firstKey) llmCache.delete(firstKey);
    }
  }
  const key = buildLlmCacheKey(task, payload, provider);
  llmCache.set(key, {
    value,
    expiresAt: Date.now() + LLM_CACHE_TTL_MS,
  });
}

function clearLlmCache() {
  const size = llmCache.size;
  llmCache.clear();
  return size;
}

async function runWithTimeout(promise, timeoutMs) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("LLM request timed out.");
      err.code = "LLM_TIMEOUT";
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function logInstanceEvent(instanceId, type, detail = null) {
  if (!instanceId || !type) return;
  const payload = detail ? JSON.stringify(detail) : null;
  db.prepare(
    "INSERT INTO instance_events (id, instance_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(randomUUID(), instanceId, type, payload, nowIso());
}

function ensureDailyBackup() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${ledger.pad2(
    now.getMonth() + 1
  )}-${ledger.pad2(now.getDate())}`;
  const backupFile = path.join(backupDir, `au_jour_le_jour_${dateStr}.sqlite`);
  if (fs.existsSync(backupFile)) return;
  if (!fs.existsSync(dbFile)) return;
  fs.copyFileSync(dbFile, backupFile);

  const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(backupDir);
  for (const name of files) {
    if (!/^au_jour_le_jour_\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)) continue;
    const full = path.join(backupDir, name);
    try {
      const stats = fs.statSync(full);
      if (stats.mtimeMs < cutoff) {
        fs.unlinkSync(full);
      }
    } catch (err) {
      // ignore stale file cleanup errors
    }
  }
}

function nowIsoLocal() {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = ledger.pad2(Math.floor(Math.abs(offset) / 60));
  const minutes = ledger.pad2(Math.abs(offset) % 60);
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
  return `${local}${sign}${hours}:${minutes}`;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch (err) {
    return null;
  }
}

function safeJsonParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function parseStoredActionResult(row) {
  if (!row) return null;
  if (!row.result) {
    if (row.status === "pending") {
      return { ok: false, error: "Action is already in progress", action_id: row.id, status: "pending" };
    }
    if (row.status === "error") {
      return { ok: false, error: "Action failed", action_id: row.id };
    }
    return { ok: true, action_id: row.id };
  }
  try {
    const parsed = JSON.parse(row.result);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (!parsed.action_id) parsed.action_id = row.id;
      return parsed;
    }
    return { ok: row.status !== "error", data: parsed, action_id: row.id };
  } catch (err) {
    if (row.status === "error") {
      return { ok: false, error: "Action failed", action_id: row.id };
    }
    return { ok: true, action_id: row.id };
  }
}

function sendStoredActionResponse(res, row) {
  const payload = parseStoredActionResult(row);
  if (row.status === "pending") {
    metrics.actions_conflicted += 1;
    return res.status(409).json(payload);
  }
  metrics.actions_replayed += 1;
  res.setHeader("X-Action-Replayed", "1");
  return res.status(row.status === "error" ? 400 : 200).json(payload);
}

function todayDate() {
  const d = new Date();
  return `${d.getFullYear()}-${ledger.pad2(d.getMonth() + 1)}-${ledger.pad2(
    d.getDate()
  )}`;
}

function normalizeTemplate(row) {
  return {
    ...row,
    autopay: Boolean(row.autopay),
    essential: Boolean(row.essential),
    active: Boolean(row.active),
    match_amount_tolerance: Number(row.match_amount_tolerance || 0),
  };
}

function normalizeInstance(row) {
  return {
    ...row,
    autopay_snapshot: Boolean(row.autopay_snapshot),
    essential_snapshot: Boolean(row.essential_snapshot),
  };
}

function parseYearMonth(req) {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12
  ) {
    return null;
  }
  return { year, month };
}

function parseEssentialsOnly(value) {
  if (value === undefined || value === null) return true;
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  return true;
}

function toBoolean(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return defaultValue;
}

function validateTemplateInput(body) {
  const name = String(body?.name || "").trim();
  if (!name) return { error: "Name is required" };

  const amountDefault = Number(body?.amount_default);
  if (!Number.isFinite(amountDefault) || amountDefault < 0) {
    return { error: "Amount must be >= 0" };
  }

  const dueDay = Number(body?.due_day);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    return { error: "Due day must be 1-31" };
  }

  const matchToleranceRaw = body?.match_amount_tolerance;
  const matchTolerance =
    matchToleranceRaw === undefined || matchToleranceRaw === null || matchToleranceRaw === ""
      ? 0
      : Number(matchToleranceRaw);
  if (!Number.isFinite(matchTolerance) || matchTolerance < 0) {
    return { error: "Match amount tolerance must be >= 0" };
  }

  return {
    name,
    category: String(body?.category || "").trim() || null,
    amount_default: amountDefault,
    due_day: dueDay,
    autopay: toBoolean(body?.autopay, false) ? 1 : 0,
    essential: toBoolean(body?.essential, true) ? 1 : 0,
    active: toBoolean(body?.active, true) ? 1 : 0,
    default_note: String(body?.default_note || "").trim() || null,
    match_payee_key: String(body?.match_payee_key || "").trim() || null,
    match_amount_tolerance: matchTolerance,
  };
}

function resolveMonthsPerCycle(cadence, monthsPerCycle) {
  if (cadence === "yearly") return 12;
  if (cadence === "quarterly") return 3;
  const parsed = Number(monthsPerCycle);
  if (!Number.isInteger(parsed) || parsed < 1) return 1;
  return parsed;
}

function validateSinkingFundInput(body) {
  const name = String(body?.name || "").trim();
  if (!name) return { error: "Name is required" };

  const targetAmount = Number(body?.target_amount);
  if (!Number.isFinite(targetAmount) || targetAmount < 0) {
    return { error: "Target amount must be >= 0" };
  }

  const dueDate = String(body?.due_date || "").trim();
  const dueError = validateDateString(dueDate, "due_date");
  if (dueError) return { error: dueError };

  const cadenceRaw = String(body?.cadence || "yearly").trim().toLowerCase();
  const cadence =
    cadenceRaw === "yearly" || cadenceRaw === "quarterly" || cadenceRaw === "custom_months"
      ? cadenceRaw
      : "yearly";

  const monthsPerCycle = resolveMonthsPerCycle(cadence, body?.months_per_cycle);

  return {
    name,
    category: String(body?.category || "").trim() || null,
    target_amount: targetAmount,
    due_date: dueDate,
    cadence,
    months_per_cycle: monthsPerCycle,
    essential: toBoolean(body?.essential, true) ? 1 : 0,
    active: toBoolean(body?.active, true) ? 1 : 0,
    auto_contribute: toBoolean(body?.auto_contribute, true) ? 1 : 0,
  };
}

function validateDateString(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${label} must be YYYY-MM-DD`;
  }
  return null;
}

function addMonthsToDate(dateString, monthsToAdd) {
  if (typeof dateString !== "string") return dateString;
  const parts = dateString.split("-");
  if (parts.length !== 3) return dateString;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return dateString;
  }
  const base = new Date(year, month - 1, 1);
  const target = new Date(base.getFullYear(), base.getMonth() + monthsToAdd, 1);
  const targetYear = target.getFullYear();
  const targetMonth = target.getMonth() + 1;
  const lastDay = ledger.getDaysInMonth(targetYear, targetMonth);
  const clampedDay = Math.min(Math.max(1, day), lastDay);
  return ledger.toDateString(targetYear, targetMonth, clampedDay);
}

function getQwenOauthSettings() {
  return getMetaJson("qwen_oauth");
}

function setQwenOauthSettings(settings) {
  setMetaJson("qwen_oauth", settings);
}

async function getQwenOauthFresh() {
  const oauth = getQwenOauthSettings();
  if (!oauth) return null;
  if (!qwenOauth.isTokenExpired(oauth)) return oauth;
  if (!oauth.refresh_token) return null;
  try {
    const tokenData = await qwenOauth.refreshAccessToken(oauth.refresh_token);
    const fresh = qwenOauth.buildOAuthSettings({
      ...tokenData,
      resource_url: tokenData.resource_url || oauth.resource_url,
    });
    setQwenOauthSettings(fresh);
    return fresh;
  } catch (err) {
    return null;
  }
}

function defaultLlmProviderState() {
  return {
    active_provider: "qwen-oauth",
    providers: {
      "qwen-oauth": {
        model: process.env.QWEN_OAUTH_MODEL || "qwen3-coder-plus",
        connected: false,
        connected_at: null,
        last_error: null,
      },
      openai: {
        model: OPENAI_DEFAULT_MODEL,
        configured: false,
        connected: false,
        connected_at: null,
        last_error: null,
        key_hint: null,
      },
      anthropic: {
        model: ANTHROPIC_DEFAULT_MODEL,
        configured: false,
        connected: false,
        connected_at: null,
        last_error: null,
        key_hint: null,
      },
    },
    updated_at: nowIso(),
  };
}

function providerDisplayName(provider) {
  const key = String(provider || "").toLowerCase();
  if (key === "openai") return "OpenAI";
  if (key === "anthropic") return "Anthropic";
  return "Qwen OAuth";
}

function getLlmProviderState() {
  const current = getMetaJson("llm_provider_state");
  if (!current || typeof current !== "object") return defaultLlmProviderState();
  const defaults = defaultLlmProviderState();
  const merged = {
    ...defaults,
    ...current,
    providers: {
      ...defaults.providers,
      ...(current.providers && typeof current.providers === "object" ? current.providers : {}),
      "qwen-oauth": {
        ...defaults.providers["qwen-oauth"],
        ...(current.providers?.["qwen-oauth"] || {}),
      },
      openai: {
        ...defaults.providers.openai,
        ...(current.providers?.openai || {}),
      },
      anthropic: {
        ...defaults.providers.anthropic,
        ...(current.providers?.anthropic || {}),
      },
    },
  };
  const active = String(merged.active_provider || "qwen-oauth").toLowerCase();
  if (!["qwen-oauth", "openai", "anthropic"].includes(active)) {
    merged.active_provider = "qwen-oauth";
  } else {
    merged.active_provider = active;
  }
  return merged;
}

function setLlmProviderState(nextState) {
  const value = {
    ...nextState,
    updated_at: nowIso(),
  };
  setMetaJson("llm_provider_state", value);
  return value;
}

function getProviderSecretKey() {
  const envSecret = String(process.env.AJL_PROVIDER_KEY_SECRET || "").trim();
  if (envSecret) {
    return createHash("sha256").update(envSecret).digest();
  }
  try {
    if (fs.existsSync(providerSecretFile)) {
      const raw = fs.readFileSync(providerSecretFile, "utf8").trim();
      if (raw) return createHash("sha256").update(raw).digest();
    }
  } catch (err) {
    // ignore read errors and regenerate
  }
  const rawSecret = randomBytes(48).toString("base64url");
  try {
    fs.writeFileSync(providerSecretFile, `${rawSecret}\n`, { mode: 0o600 });
  } catch (err) {
    // ignore write errors; key remains process-local fallback
  }
  return createHash("sha256").update(rawSecret).digest();
}

function encryptProviderSecret(plainText) {
  const text = String(plainText || "");
  if (!text) return "";
  const key = getProviderSecretKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptProviderSecret(encryptedValue) {
  const raw = String(encryptedValue || "");
  if (!raw || !raw.startsWith("v1:")) return "";
  const parts = raw.split(":");
  if (parts.length !== 4) return "";
  const [, ivRaw, tagRaw, dataRaw] = parts;
  try {
    const key = getProviderSecretKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    const clear = Buffer.concat([
      decipher.update(Buffer.from(dataRaw, "base64url")),
      decipher.final(),
    ]);
    return clear.toString("utf8");
  } catch (err) {
    return "";
  }
}

function getProviderSecrets() {
  const value = getMetaJson("llm_provider_secrets");
  if (!value || typeof value !== "object") return {};
  return value;
}

function setProviderSecrets(next) {
  setMetaJson("llm_provider_secrets", next && typeof next === "object" ? next : {});
}

function getKeyHint(apiKey) {
  const value = String(apiKey || "").trim();
  if (!value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function getProviderCredential(provider) {
  const secrets = getProviderSecrets();
  const row = secrets && typeof secrets === "object" ? secrets[provider] : null;
  if (!row || typeof row !== "object") return null;
  const apiKey = decryptProviderSecret(row.api_key || "");
  if (!apiKey) return null;
  return {
    api_key: apiKey,
    key_hint: row.key_hint || getKeyHint(apiKey),
    base_url: row.base_url || null,
    model: row.model || null,
    updated_at: row.updated_at || null,
  };
}

function setProviderCredential(provider, credential) {
  const secrets = getProviderSecrets();
  const next = {
    ...(secrets && typeof secrets === "object" ? secrets : {}),
  };
  if (!credential || !credential.api_key) {
    delete next[provider];
    setProviderSecrets(next);
    return;
  }
  next[provider] = {
    api_key: encryptProviderSecret(credential.api_key),
    key_hint: getKeyHint(credential.api_key),
    base_url: credential.base_url || null,
    model: credential.model || null,
    updated_at: nowIso(),
  };
  setProviderSecrets(next);
}

function validProviderName(value) {
  return ["qwen-oauth", "openai", "anthropic"].includes(String(value || "").toLowerCase());
}

function normalizeProviderName(value) {
  return String(value || "").trim().toLowerCase();
}

function validateApiKeyInput(provider, apiKeyRaw) {
  const apiKey = String(apiKeyRaw || "").trim();
  if (!apiKey) return { ok: false, error: "API key is required." };
  if (provider === "openai" && !/^sk-[A-Za-z0-9_\-]{20,}$/.test(apiKey)) {
    return { ok: false, error: "OpenAI key format looks invalid." };
  }
  if (provider === "anthropic" && !/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(apiKey)) {
    return { ok: false, error: "Anthropic key format looks invalid." };
  }
  return { ok: true, apiKey };
}

async function testOpenAIConnection({ apiKey, model, baseUrl }) {
  const endpoint = `${String(baseUrl || OPENAI_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || OPENAI_DEFAULT_MODEL,
      messages: [{ role: "user", content: "Respond with exactly: ok" }],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message = payload?.error?.message || `OpenAI test failed (${res.status}).`;
    return { ok: false, error: message };
  }
  return { ok: true, model: payload?.model || model || OPENAI_DEFAULT_MODEL };
}

async function testAnthropicConnection({ apiKey, model, baseUrl }) {
  const endpoint = `${String(baseUrl || ANTHROPIC_BASE_URL).replace(/\/+$/, "")}/messages`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: model || ANTHROPIC_DEFAULT_MODEL,
      messages: [{ role: "user", content: "Respond with exactly: ok" }],
      max_tokens: 8,
      temperature: 0,
    }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message = payload?.error?.message || `Anthropic test failed (${res.status}).`;
    return { ok: false, error: message };
  }
  return { ok: true, model: payload?.model || model || ANTHROPIC_DEFAULT_MODEL };
}

async function testProviderConnection(provider, input) {
  if (process.env.AJL_LLM_MOCK === "1") {
    return { ok: true, model: input.model || (provider === "openai" ? OPENAI_DEFAULT_MODEL : ANTHROPIC_DEFAULT_MODEL) };
  }
  if (provider === "openai") return testOpenAIConnection(input);
  if (provider === "anthropic") return testAnthropicConnection(input);
  return { ok: false, error: "Unsupported provider for API-key test." };
}

async function buildProviderStatus() {
  const state = getLlmProviderState();
  const oauthFresh = await getQwenOauthFresh();
  const qwenConnected = !!oauthFresh && !qwenOauth.isTokenExpired(oauthFresh);

  state.providers["qwen-oauth"] = {
    ...state.providers["qwen-oauth"],
    connected: qwenConnected,
    model: state.providers["qwen-oauth"]?.model || process.env.QWEN_OAUTH_MODEL || "qwen3-coder-plus",
    last_error: qwenConnected ? null : state.providers["qwen-oauth"]?.last_error || null,
  };

  ["openai", "anthropic"].forEach((provider) => {
    const credential = getProviderCredential(provider);
    const configured = !!credential?.api_key;
    const persistedConnected = !!state.providers?.[provider]?.connected;
    state.providers[provider] = {
      ...state.providers[provider],
      configured,
      connected: configured && persistedConnected,
      key_hint: credential?.key_hint || state.providers[provider]?.key_hint || null,
      model:
        credential?.model ||
        state.providers[provider]?.model ||
        (provider === "openai" ? OPENAI_DEFAULT_MODEL : ANTHROPIC_DEFAULT_MODEL),
      base_url:
        credential?.base_url ||
        state.providers[provider]?.base_url ||
        (provider === "openai" ? OPENAI_BASE_URL : ANTHROPIC_BASE_URL),
      last_error: state.providers[provider]?.last_error || null,
    };
  });

  const active = normalizeProviderName(state.active_provider);
  if (active === "qwen-oauth" && !qwenConnected) {
    state.providers["qwen-oauth"].connected = false;
  }
  return state;
}

function deriveStatus(instance, amountPaid) {
  if (instance.status === "skipped") return "skipped";
  if (amountPaid <= 0) return "pending";
  if (amountPaid < Number(instance.amount || 0)) return "partial";
  return "paid";
}

function attachPayments(instances) {
  if (instances.length === 0) return [];
  const ids = instances.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const totals = db
    .prepare(
      `SELECT instance_id, SUM(amount) as total FROM payment_events WHERE instance_id IN (${placeholders}) GROUP BY instance_id`
    )
    .all(...ids);
  const totalsMap = new Map(
    totals.map((row) => [row.instance_id, Number(row.total || 0)])
  );

  return instances.map((row) => {
    const normalized = normalizeInstance(row);
    const amountPaid = Number(normalized.amount_paid ?? totalsMap.get(row.id) ?? 0);
    const amountDue = Number(normalized.amount || 0);
    const amountRemaining = Math.max(0, amountDue - amountPaid);
    return {
      ...normalized,
      amount_paid: amountPaid,
      amount_remaining: amountRemaining,
      status_derived: deriveStatus(normalized, amountPaid),
    };
  });
}

function getPaymentsForMonth(year, month) {
  return db
    .prepare(
      `SELECT p.id, p.instance_id, p.amount, p.paid_date, p.created_at,
              i.name_snapshot, i.year, i.month
       FROM payment_events p
       JOIN instances i ON i.id = p.instance_id
       WHERE i.year = ? AND i.month = ?
       ORDER BY p.paid_date DESC, p.created_at DESC`
    )
    .all(year, month);
}

function getAmountPaid(instanceId) {
  const row = db
    .prepare("SELECT SUM(amount) as total FROM payment_events WHERE instance_id = ?")
    .get(instanceId);
  return Number(row?.total || 0);
}

function normalizeSinkingFund(row) {
  return {
    ...row,
    essential: Boolean(row.essential),
    active: Boolean(row.active),
    auto_contribute: Boolean(row.auto_contribute),
    target_amount: Number(row.target_amount || 0),
    months_per_cycle: Number(row.months_per_cycle || 1),
  };
}

function getReferenceDate(year, month) {
  const now = new Date();
  if (now.getFullYear() === year && now.getMonth() + 1 === month) return now;
  return new Date(year, month - 1, 1);
}

function computeMonthsRemaining(refDate, dueDate) {
  if (!(dueDate instanceof Date) || Number.isNaN(dueDate.valueOf())) return 0;
  if (dueDate <= refDate) return 0;
  const refY = refDate.getFullYear();
  const refM = refDate.getMonth() + 1;
  const refD = refDate.getDate();
  const dueY = dueDate.getFullYear();
  const dueM = dueDate.getMonth() + 1;
  const dueD = dueDate.getDate();
  let months = (dueY - refY) * 12 + (dueM - refM);
  if (dueD >= refD) months += 1;
  return months;
}

function getSinkingBalances() {
  const rows = db
    .prepare(
      `SELECT fund_id,
              SUM(CASE WHEN type = 'WITHDRAWAL' THEN -amount ELSE amount END) as balance
       FROM sinking_events
       GROUP BY fund_id`
    )
    .all();
  return new Map(rows.map((row) => [row.fund_id, Number(row.balance || 0)]));
}

function computeSinkingFundView(fund, balance, refDate) {
  const target = Number(fund.target_amount || 0);
  const dueDate = new Date(`${fund.due_date}T00:00:00`);
  const monthsRemaining = computeMonthsRemaining(refDate, dueDate);
  let monthlyContrib = 0;
  if (target > 0 && balance < target && monthsRemaining > 0) {
    monthlyContrib = (target - balance) / monthsRemaining;
  }
  if (balance >= target) monthlyContrib = 0;

  const monthsPerCycle = resolveMonthsPerCycle(fund.cadence, fund.months_per_cycle);
  const monthsElapsed = Math.max(
    0,
    Math.min(monthsPerCycle, monthsPerCycle - monthsRemaining)
  );
  const expectedSaved =
    monthsPerCycle > 0 ? target * (monthsElapsed / monthsPerCycle) : 0;
  const progressRatio = target > 0 ? balance / target : 1;

  let status = "on_track";
  if (dueDate <= refDate) status = "due";
  else if (balance >= target) status = "ready";
  else if (balance + 0.01 < expectedSaved) status = "behind";

  return {
    ...normalizeSinkingFund(fund),
    balance,
    monthly_contrib: Number(monthlyContrib.toFixed(2)),
    months_remaining: monthsRemaining,
    status,
    progress_ratio: progressRatio,
    expected_saved: Number(expectedSaved.toFixed(2)),
  };
}

function getSinkingFunds(year, month, includeInactive = false) {
  const refDate = getReferenceDate(year, month);
  const funds = db
    .prepare(
      `SELECT * FROM sinking_funds ${includeInactive ? "" : "WHERE active = 1"} ORDER BY due_date`
    )
    .all();
  const balanceMap = getSinkingBalances();
  return funds.map((fund) =>
    computeSinkingFundView(fund, Number(balanceMap.get(fund.id) || 0), refDate)
  );
}

function hasContributionEvent(fundId, year, month) {
  const key = `${year}-${ledger.pad2(month)}`;
  const row = db
    .prepare(
      `SELECT id FROM sinking_events
       WHERE fund_id = ? AND type = 'CONTRIBUTION' AND substr(event_date, 1, 7) = ?
       LIMIT 1`
    )
    .get(fundId, key);
  return !!row;
}

function autoContributeForMonth(year, month) {
  const refDate = new Date(year, month - 1, 1);
  const funds = db
    .prepare("SELECT * FROM sinking_funds WHERE active = 1 AND auto_contribute = 1")
    .all();
  const balanceMap = getSinkingBalances();
  const insert = db.prepare(
    `INSERT INTO sinking_events (id, fund_id, amount, type, event_date, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const run = db.transaction(() => {
    for (const fund of funds) {
      if (hasContributionEvent(fund.id, year, month)) continue;
      const view = computeSinkingFundView(
        fund,
        Number(balanceMap.get(fund.id) || 0),
        refDate
      );
      const amount = Number(view.monthly_contrib || 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const eventDate = `${year}-${ledger.pad2(month)}-01`;
      insert.run(
        randomUUID(),
        fund.id,
        amount,
        "CONTRIBUTION",
        eventDate,
        "Auto contribution",
        nowIso()
      );
    }
  });

  run();
}

function monthIndex(year, month) {
  return year * 12 + (month - 1);
}

function getLastNMonths(year, month, windowSize) {
  const months = [];
  let y = year;
  let m = month;
  for (let i = 0; i < windowSize; i += 1) {
    months.push({ year: y, month: m });
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
  }
  return months;
}

function diffDays(dateA, dateB) {
  const a = new Date(`${dateA}T00:00:00`);
  const b = new Date(`${dateB}T00:00:00`);
  return Math.round((a - b) / (1000 * 60 * 60 * 24));
}

function computeBehaviorFeatures(year, month, windowSize) {
  const months = getLastNMonths(year, month, windowSize);
  const indices = months.map((m) => monthIndex(m.year, m.month));
  const minIndex = Math.min(...indices);
  const maxIndex = Math.max(...indices);

  const instances = db
    .prepare(
      `SELECT * FROM instances WHERE (year * 12 + (month - 1)) BETWEEN ? AND ?`
    )
    .all(minIndex, maxIndex);

  const instanceIds = instances.map((row) => row.id);
  const paymentTotals = new Map();
  const paymentDates = new Map();
  if (instanceIds.length > 0) {
    const placeholders = instanceIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT instance_id, SUM(amount) as total, MAX(paid_date) as last_date
         FROM payment_events WHERE instance_id IN (${placeholders}) GROUP BY instance_id`
      )
      .all(...instanceIds);
    rows.forEach((row) => {
      paymentTotals.set(row.instance_id, Number(row.total || 0));
      paymentDates.set(row.instance_id, row.last_date || null);
    });
  }

  const templateStats = new Map();
  const perMonthRanks = new Map();

  const monthKey = (y, m) => `${y}-${ledger.pad2(m)}`;
  instances.forEach((inst) => {
    const totalPaid = Number(paymentTotals.get(inst.id) || 0);
    const lastDate = paymentDates.get(inst.id);
    const templateId = inst.template_id;
    if (!templateStats.has(templateId)) {
      templateStats.set(templateId, {
        template_id: templateId,
        name: inst.name_snapshot,
        category: inst.category_snapshot || null,
        total_instances: 0,
        paid_instances: 0,
        on_time_paid: 0,
        late_paid: 0,
        sum_offset: 0,
        offset_count: 0,
        rank_sum: 0,
        rank_count: 0,
        per_month_paid: new Map(),
      });
    }

    const stat = templateStats.get(templateId);
    stat.total_instances += 1;

    const paidFlag =
      totalPaid >= Number(inst.amount || 0) && Number(inst.amount || 0) > 0;
    const periodKey = monthKey(inst.year, inst.month);
    stat.per_month_paid.set(periodKey, paidFlag);

    if (paidFlag && lastDate) {
      stat.paid_instances += 1;
      const offset = diffDays(lastDate, inst.due_date);
      stat.sum_offset += offset;
      stat.offset_count += 1;
      if (offset <= 0) stat.on_time_paid += 1;
      if (offset > 0) stat.late_paid += 1;
    }

    if (lastDate) {
      const list = perMonthRanks.get(periodKey) || [];
      list.push({ template_id: templateId, last_date: lastDate });
      perMonthRanks.set(periodKey, list);
    }
  });

  perMonthRanks.forEach((list) => {
    list.sort((a, b) => a.last_date.localeCompare(b.last_date));
    list.forEach((item, index) => {
      const stat = templateStats.get(item.template_id);
      if (!stat) return;
      stat.rank_sum += index + 1;
      stat.rank_count += 1;
    });
  });

  const lastThree = getLastNMonths(year, month, 3).map((m) =>
    monthKey(m.year, m.month)
  );

  const perBill = Array.from(templateStats.values()).map((stat) => {
    const avgOffset = stat.offset_count ? stat.sum_offset / stat.offset_count : 0;
    const onTimeRate = stat.paid_instances ? stat.on_time_paid / stat.paid_instances : 0;
    const lateRate = stat.paid_instances ? stat.late_paid / stat.paid_instances : 0;
    const consistency = stat.total_instances ? stat.paid_instances / stat.total_instances : 0;
    const typicalRank = stat.rank_count ? stat.rank_sum / stat.rank_count : null;
    const lastFlags = lastThree.map((key) => stat.per_month_paid.get(key) || false);

    return {
      template_id: stat.template_id,
      name: stat.name,
      category: stat.category,
      avg_pay_day_offset: Number(avgOffset.toFixed(2)),
      on_time_rate: Number(onTimeRate.toFixed(2)),
      typical_payment_order_rank: typicalRank ? Number(typicalRank.toFixed(2)) : null,
      last_3_months_paid_flag: lastFlags,
      payment_consistency_score: Number(consistency.toFixed(2)),
      lateness_trend: Number(lateRate.toFixed(2)),
      typical_pay_window_days: stat.offset_count
        ? Number(Math.abs(avgOffset).toFixed(2))
        : null,
    };
  });

  const currentInstances = getInstances(year, month);
  const essentials = currentInstances.filter((i) => i.essential_snapshot);
  const essentialsRequired = essentials
    .filter((i) => i.status_derived !== 'skipped')
    .reduce((sum, i) => sum + Number(i.amount || 0), 0);
  const essentialsPaid = essentials
    .filter((i) => i.status_derived !== 'skipped')
    .reduce((sum, i) => sum + Math.min(Number(i.amount || 0), Number(i.amount_paid || 0)), 0);
  const percentEssentialsPaid = essentialsRequired
    ? Number((essentialsPaid / essentialsRequired).toFixed(2))
    : 0;

  const today = getTodayDateString();
  const nextDue = currentInstances
    .filter((i) => i.status_derived !== 'skipped' && i.amount_remaining > 0)
    .map((i) => diffDays(i.due_date, today))
    .filter((diff) => diff >= 0)
    .sort((a, b) => a - b)[0];

  const summary = ledger.computeSummary(currentInstances, {
    year,
    month,
    essentialsOnly: true,
    todayDate: new Date(),
  });

  return {
    global: {
      percent_essentials_paid: percentEssentialsPaid,
      days_until_next_due: Number.isFinite(nextDue) ? nextDue : null,
      current_free_for_month_flag: summary.free_for_month,
    },
    per_bill: perBill,
  };
}

function ensureMonth(year, month) {
  const templates = db.prepare("SELECT * FROM templates WHERE active = 1").all();
  const find = db.prepare(
    "SELECT id FROM instances WHERE template_id = ? AND year = ? AND month = ?"
  );
  const insert = db.prepare(
    `INSERT INTO instances (
      id, template_id, year, month, name_snapshot, category_snapshot, amount, due_date,
      autopay_snapshot, essential_snapshot, status, paid_date, note, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const stamp = nowIso();

  const run = db.transaction(() => {
    for (const template of templates) {
      const exists = find.get(template.id, year, month);
      if (exists) continue;
      const dueDay = ledger.clampDueDay(year, month, template.due_day);
      const dueDate = ledger.toDateString(year, month, dueDay);
      const instanceId = randomUUID();
      insert.run(
        instanceId,
        template.id,
        year,
        month,
        template.name,
        template.category || null,
        template.amount_default,
        dueDate,
        template.autopay ? 1 : 0,
        template.essential ? 1 : 0,
        "pending",
        null,
        template.default_note || null,
        stamp,
        stamp
      );
      logInstanceEvent(instanceId, "created", {
        source: "template",
        name: template.name,
        due_date: dueDate,
        amount: Number(template.amount_default || 0),
      });
    }
  });

  run();
  autoContributeForMonth(year, month);
}

function applyTemplateToMonth(template, year, month) {
  if (!template || !year || !month) return;
  if (template.active) {
    ensureMonth(year, month);
  }
  const dueDay = ledger.clampDueDay(year, month, template.due_day);
  const dueDate = ledger.toDateString(year, month, dueDay);
  db.prepare(
    `UPDATE instances
     SET name_snapshot = ?, category_snapshot = ?, amount = ?, due_date = ?, autopay_snapshot = ?, essential_snapshot = ?, updated_at = ?
     WHERE template_id = ? AND year = ? AND month = ?`
  ).run(
    template.name,
    template.category || null,
    template.amount_default,
    dueDate,
    template.autopay ? 1 : 0,
    template.essential ? 1 : 0,
    nowIso(),
    template.id,
    year,
    month
  );
}

function deleteTemplateFromMonth(id, year, month) {
  const rows = db
    .prepare(
      `SELECT id FROM instances
       WHERE template_id = ?
         AND (year > ? OR (year = ? AND month >= ?))`
    )
    .all(id, year, year, month);
  const instanceIds = rows.map((r) => r.id);
  const run = db.transaction(() => {
    if (instanceIds.length > 0) {
      const placeholders = instanceIds.map(() => "?").join(",");
      db.prepare(
        `DELETE FROM payment_events WHERE instance_id IN (${placeholders})`
      ).run(...instanceIds);
      db.prepare(`DELETE FROM instances WHERE id IN (${placeholders})`).run(
        ...instanceIds
      );
    }
    db.prepare("DELETE FROM templates WHERE id = ?").run(id);
  });
  return run();
}

function getInstances(year, month) {
  const rows = db
    .prepare(
      "SELECT * FROM instances WHERE year = ? AND month = ? ORDER BY due_date ASC, name_snapshot COLLATE NOCASE"
    )
    .all(year, month);
  return attachPayments(rows);
}

app.get("/api/ensure-month", (req, res) => {
  const parsed = parseYearMonth(req);
  if (!parsed) return res.status(400).json({ error: "Invalid year/month" });
  ensureMonth(parsed.year, parsed.month);
  return res.json({ ok: true });
});

app.get("/api/templates", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM templates ORDER BY name COLLATE NOCASE")
    .all();
  res.json(rows.map(normalizeTemplate));
});

app.post("/api/templates", (req, res) => {
  const payload = validateTemplateInput(req.body);
  if (payload.error) return res.status(400).json({ error: payload.error });

  const stamp = nowIso();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO templates (
      id, name, category, amount_default, due_day, autopay, essential, active, default_note,
      match_payee_key, match_amount_tolerance, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    payload.name,
    payload.category,
    payload.amount_default,
    payload.due_day,
    payload.autopay,
    payload.essential,
    payload.active,
    payload.default_note,
    payload.match_payee_key,
    payload.match_amount_tolerance,
    stamp,
    stamp
  );

  const parsed = parseYearMonth(req);
  const now = new Date();
  const year = parsed?.year ?? now.getFullYear();
  const month = parsed?.month ?? now.getMonth() + 1;
  ensureMonth(year, month);
  const template = db.prepare("SELECT * FROM templates WHERE id = ?").get(id);
  res.json(normalizeTemplate(template));
});

app.put("/api/templates/:id", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const payload = validateTemplateInput(req.body);
  if (payload.error) return res.status(400).json({ error: payload.error });

  const stamp = nowIso();
  const result = db.prepare(
    `UPDATE templates
     SET name = ?, category = ?, amount_default = ?, due_day = ?, autopay = ?, essential = ?, active = ?,
         default_note = ?, match_payee_key = ?, match_amount_tolerance = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    payload.name,
    payload.category,
    payload.amount_default,
    payload.due_day,
    payload.autopay,
    payload.essential,
    payload.active,
    payload.default_note,
    payload.match_payee_key,
    payload.match_amount_tolerance,
    stamp,
    id
  );

  if (result.changes === 0) {
    return res.status(404).json({ error: "Template not found" });
  }

  const row = db.prepare("SELECT * FROM templates WHERE id = ?").get(id);
  const parsed = parseYearMonth(req);
  const now = new Date();
  const year = parsed?.year ?? now.getFullYear();
  const month = parsed?.month ?? now.getMonth() + 1;
  applyTemplateToMonth(row, year, month);
  res.json(normalizeTemplate(row));
});

app.post("/api/templates/:id/archive", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const stamp = nowIso();
  const result = db
    .prepare("UPDATE templates SET active = 0, updated_at = ? WHERE id = ?")
    .run(stamp, id);
  if (result.changes === 0) return res.status(404).json({ error: "Template not found" });
  res.json({ ok: true });
});

app.delete("/api/templates/:id", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const parsed = parseYearMonth(req);
  const now = new Date();
  const year = parsed?.year ?? now.getFullYear();
  const month = parsed?.month ?? now.getMonth() + 1;
  const exists = db.prepare("SELECT id FROM templates WHERE id = ?").get(id);
  if (!exists) return res.status(404).json({ error: "Template not found" });
  deleteTemplateFromMonth(id, year, month);
  res.json({ ok: true });
});

app.get("/api/instances", (req, res) => {
  const parsed = parseYearMonth(req);
  if (!parsed) return res.status(400).json({ error: "Invalid year/month" });
  const rows = getInstances(parsed.year, parsed.month);
  res.json(rows);
});

app.get("/api/instances/:id/events", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const rows = db
    .prepare(
      `SELECT id, instance_id, type, detail, created_at
       FROM instance_events
       WHERE instance_id = ?
       ORDER BY datetime(created_at) DESC`
    )
    .all(id);
  const events = rows.map((row) => ({
    id: row.id,
    instance_id: row.instance_id,
    type: row.type,
    detail: safeJsonParse(row.detail),
    created_at: row.created_at,
  }));
  res.json(events);
});

app.get("/api/instance-events", (req, res) => {
  const parsed = parseYearMonth(req);
  if (!parsed) return res.status(400).json({ error: "Invalid year/month" });
  const rows = db
    .prepare(
      `SELECT e.id, e.instance_id, e.type, e.detail, e.created_at, i.name_snapshot
       FROM instance_events e
       JOIN instances i ON i.id = e.instance_id
       WHERE i.year = ? AND i.month = ?
       ORDER BY datetime(e.created_at) DESC`
    )
    .all(parsed.year, parsed.month);
  const events = rows.map((row) => ({
    id: row.id,
    instance_id: row.instance_id,
    name: row.name_snapshot,
    type: row.type,
    detail: safeJsonParse(row.detail),
    created_at: row.created_at,
  }));
  res.json(events);
});

app.patch("/api/instances/:id", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const fields = [];
  const values = [];
  const body = req.body || {};
  const before = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
  if (!before) return res.status(404).json({ error: "Instance not found" });
  const changes = {};
  let statusChange = null;
  let noteChange = null;

  if (body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: "Amount must be >= 0" });
    }
    if (Number(before.amount || 0) !== amount) {
      changes.amount = { from: Number(before.amount || 0), to: amount };
    }
    fields.push("amount = ?");
    values.push(amount);
  }
  if (body.name_snapshot !== undefined || body.name !== undefined) {
    const nameValue = String(body.name_snapshot ?? body.name ?? "").trim();
    if (!nameValue) return res.status(400).json({ error: "Name is required" });
    if (String(before.name_snapshot || "") !== nameValue) {
      changes.name = { from: String(before.name_snapshot || ""), to: nameValue };
    }
    fields.push("name_snapshot = ?");
    values.push(nameValue);
  }
  if (body.category_snapshot !== undefined || body.category !== undefined) {
    const categoryValue = String(body.category_snapshot ?? body.category ?? "").trim();
    if (String(before.category_snapshot || "") !== categoryValue) {
      changes.category = { from: before.category_snapshot || "", to: categoryValue || "" };
    }
    fields.push("category_snapshot = ?");
    values.push(categoryValue || null);
  }
  if (body.due_date !== undefined) {
    const error = validateDateString(body.due_date, "due_date");
    if (error) return res.status(400).json({ error });
    if (String(before.due_date || "") !== body.due_date) {
      changes.due_date = { from: before.due_date || "", to: body.due_date };
    }
    fields.push("due_date = ?");
    values.push(body.due_date);
  }
  if (body.status !== undefined) {
    if (!["pending", "paid", "skipped"].includes(body.status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    if (String(before.status || "") !== body.status) {
      statusChange = { from: before.status || "", to: body.status };
    }
    fields.push("status = ?");
    values.push(body.status);
  }
  if (body.paid_date !== undefined) {
    const error = validateDateString(body.paid_date, "paid_date");
    if (error) return res.status(400).json({ error });
    fields.push("paid_date = ?");
    values.push(body.paid_date);
  }
  if (body.note !== undefined) {
    if (String(before.note || "") !== String(body.note || "")) {
      noteChange = { from: before.note || "", to: body.note || "" };
    }
    fields.push("note = ?");
    values.push(body.note || null);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  fields.push("updated_at = ?");
  values.push(nowIso());
  values.push(id);

  db.prepare(`UPDATE instances SET ${fields.join(", ")} WHERE id = ?`).run(
    ...values
  );
  const row = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Instance not found" });

  if (statusChange) {
    const type =
      statusChange.to === "skipped"
        ? "skipped"
        : statusChange.from === "skipped"
        ? "unskipped"
        : "status_changed";
    logInstanceEvent(id, type, statusChange);
  }
  if (noteChange) {
    logInstanceEvent(id, "note_updated", noteChange);
  }
  const changeKeys = Object.keys(changes);
  if (changeKeys.length > 0) {
    logInstanceEvent(id, "edited", { changes });
  }

  res.json(attachPayments([row])[0]);
});

app.post("/api/instances/:id/mark-paid", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const instance = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
  if (!instance) return res.status(404).json({ error: "Instance not found" });
  const amountPaid = getAmountPaid(id);
  const amountDue = Number(instance.amount || 0);
  const remaining = Math.max(0, amountDue - amountPaid);
  let paymentId = null;
  if (remaining > 0) {
    paymentId = randomUUID();
    db.prepare(
      "INSERT INTO payment_events (id, instance_id, amount, paid_date, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(paymentId, id, remaining, todayDate(), nowIso());
  }
  db.prepare(
    "UPDATE instances SET status = 'paid', paid_date = ?, updated_at = ? WHERE id = ?"
  ).run(todayDate(), nowIso(), id);
  logInstanceEvent(id, "marked_done", {
    paid_date: todayDate(),
    amount: Number(instance.amount || 0),
    payment_id: paymentId,
  });
  const row = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
  res.json(attachPayments([row])[0]);
});

app.post("/api/instances/:id/undo-paid", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) return res.status(400).json({ error: "Invalid id" });
  db.prepare("DELETE FROM payment_events WHERE instance_id = ?").run(id);
  db.prepare(
    "UPDATE instances SET status = 'pending', paid_date = NULL, updated_at = ? WHERE id = ?"
  ).run(nowIso(), id);
  logInstanceEvent(id, "status_changed", { from: "paid", to: "pending" });
  const row = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Instance not found" });
  res.json(attachPayments([row])[0]);
});

app.post("/api/instances/:id/payments", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Amount must be > 0" });
  }
  const paidDate = req.body?.paid_date || todayDate();
  const error = validateDateString(paidDate, "paid_date");
  if (error) return res.status(400).json({ error });

  const instance = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
  if (!instance) return res.status(404).json({ error: "Instance not found" });

  const paymentId = randomUUID();
  db.prepare(
    "INSERT INTO payment_events (id, instance_id, amount, paid_date, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(paymentId, id, amount, paidDate, nowIso());
  logInstanceEvent(id, "log_update", { amount, date: paidDate, payment_id: paymentId });

  const updated = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
  res.json({
    ok: true,
    payment: {
      id: paymentId,
      instance_id: id,
      amount,
      paid_date: paidDate,
    },
    instance: attachPayments([updated])[0],
  });
});

app.get("/api/payments", (req, res) => {
  const parsed = parseYearMonth(req);
  if (!parsed) return res.status(400).json({ error: "Invalid year/month" });
  const rows = getPaymentsForMonth(parsed.year, parsed.month);
  res.json(rows);
});

app.delete("/api/payments/:id", (req, res) => {
  const id = String(req.params.id || "");
  if (!id) return res.status(400).json({ error: "Invalid id" });
  const payment = db.prepare("SELECT * FROM payment_events WHERE id = ?").get(id);
  if (!payment) return res.status(404).json({ error: "Payment not found" });
  db.prepare("DELETE FROM payment_events WHERE id = ?").run(id);
  logInstanceEvent(payment.instance_id, "update_removed", {
    amount: Number(payment.amount || 0),
    date: payment.paid_date,
    payment_id: payment.id,
  });
  const instance = db
    .prepare("SELECT * FROM instances WHERE id = ?")
    .get(payment.instance_id);
  res.json({
    ok: true,
    instance_id: payment.instance_id,
    instance: instance ? attachPayments([instance])[0] : null,
  });
});

app.get("/api/chat", (req, res) => {
  const limitRaw = Number(req.query.limit || 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50;
  const rows = db
    .prepare("SELECT * FROM assistant_chat ORDER BY datetime(created_at) ASC LIMIT ?")
    .all(limit);
  res.json({ ok: true, items: rows });
});

app.post("/api/chat", (req, res) => {
  const body = req.body || {};
  const role = String(body.role || "").trim();
  const text = String(body.text || "").trim();
  if (!role || !text) return res.status(400).json({ ok: false, error: "Invalid message" });
  const meta = body.meta ? String(body.meta) : null;
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare(
    "INSERT INTO assistant_chat (id, created_at, role, text, meta) VALUES (?, ?, ?, ?, ?)"
  ).run(id, createdAt, role, text, meta);
  res.json({ ok: true, id });
});

app.delete("/api/chat", (req, res) => {
  db.prepare("DELETE FROM assistant_chat").run();
  res.json({ ok: true });
});

app.get("/api/settings", (req, res) => {
  const stored = getMetaJson("settings") || {};
  const settings = {
    defaults: { sort: "due_date", dueSoonDays: 7, defaultPeriod: "month" },
    categories: [],
    share_base_url: SHARE_RELAY_BASE_URL,
    share_viewer_base_url: getViewerBaseUrl(req),
    firstRunCompleted: !!stored.firstRunCompleted,
    hasCompletedOnboarding: !!(stored.hasCompletedOnboarding ?? stored.firstRunCompleted),
  };
  if (stored.defaults) settings.defaults = stored.defaults;
  if (Array.isArray(stored.categories)) settings.categories = stored.categories;
  res.json(settings);
});

app.post("/api/settings", (req, res) => {
  const body = req.body || {};
  const defaults = body.defaults || {};
  const allowedSort = new Set(["due_date", "amount", "name", "status"]);
  const sort = allowedSort.has(defaults.sort) ? defaults.sort : "due_date";
  let dueSoonDays = Number(defaults.dueSoonDays ?? 7);
  if (!Number.isFinite(dueSoonDays) || dueSoonDays < 1 || dueSoonDays > 31) {
    dueSoonDays = 7;
  }
  const defaultPeriod = defaults.defaultPeriod === "month" ? "month" : "month";
  const categories = Array.isArray(body.categories)
    ? body.categories.map((c) => String(c || "").trim()).filter(Boolean)
    : [];
  const firstRunCompleted = body.firstRunCompleted === true;
  const hasCompletedOnboarding =
    body.hasCompletedOnboarding === true || body.firstRunCompleted === true;
  const payload = {
    defaults: { sort, dueSoonDays, defaultPeriod },
    categories,
    share_base_url: SHARE_RELAY_BASE_URL,
    share_viewer_base_url: getViewerBaseUrl(req),
    firstRunCompleted,
    hasCompletedOnboarding,
  };
  setMetaJson("settings", payload);
  res.json(payload);
});

app.post("/api/reset-local", (req, res) => {
  db.transaction(() => {
    db.prepare("DELETE FROM templates").run();
    db.prepare("DELETE FROM instances").run();
    db.prepare("DELETE FROM payment_events").run();
    db.prepare("DELETE FROM instance_events").run();
    db.prepare("DELETE FROM month_settings").run();
    db.prepare("DELETE FROM sinking_funds").run();
    db.prepare("DELETE FROM sinking_events").run();
    db.prepare("DELETE FROM actions").run();
    db.prepare("DELETE FROM agent_command_log").run();
    db.prepare("DELETE FROM assistant_chat").run();
    db.prepare("DELETE FROM oauth_device_sessions").run();
    db.prepare("DELETE FROM meta").run();
  })();
  res.json({ ok: true });
});

app.get("/api/lan", (req, res) => {
  const addresses = shareRuntime.getLanIPv4List();
  const hostHeader = req.get("host") || "";
  const headerPort = Number(hostHeader.split(":")[1]);
  const port = Number.isFinite(headerPort) ? headerPort : PORT;
  const urls = addresses.map((addr) => `http://${addr}:${port}`);
  res.json({ ok: true, port, addresses, urls });
});

app.get("/s/:token", (req, res) => {
  const token = String(req.params.token || "");
  if (!isValidShareToken(token)) {
    return res.status(404).send("Not found");
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/shares", (req, res) => {
  if (!requireOwner(req, res)) return;
  expireStaleShares();
  const row = db
    .prepare("SELECT * FROM shares WHERE is_active = 1 ORDER BY datetime(updated_at) DESC LIMIT 1")
    .get();
  if (!row) return res.json({ share: null });
  const ownerSecret = getOwnerSecret();
  res.json({
    share: {
      token: row.token,
      mode: row.mode,
      is_active: !!row.is_active,
      owner_label: row.owner_label || null,
      expires_at: row.expires_at || null,
      last_published_at: row.last_published_at || null,
      shareUrl: buildViewerShareUrl(req, row.token),
      ownerKey: ownerSecret,
    },
  });
});

app.post("/api/shares", (req, res) => {
  if (!requireOwner(req, res)) return;
  const mode = req.body?.mode === "snapshot" ? "snapshot" : "live";
  const ownerLabel = sanitizeOwnerLabel(req.body?.owner_label);
  const expires = parseShareExpiresAt(req.body?.expires_at);
  if (!expires.ok) return res.status(400).json({ error: expires.error });
  const token = generateShareToken();
  const now = nowIso();
  db.prepare("UPDATE shares SET is_active = 0, updated_at = ? WHERE is_active = 1").run(now);
  db.prepare(
    `INSERT INTO shares (token, mode, is_active, payload, payload_version, owner_label, expires_at, created_at, updated_at)
     VALUES (?, ?, 1, NULL, NULL, ?, ?, ?, ?)`
  ).run(token, mode, ownerLabel, expires.value === undefined ? null : expires.value, now, now);
  const ownerSecret = getOwnerSecret();
  res.json({
    shareUrl: buildViewerShareUrl(req, token),
    shareToken: token,
    mode,
    expires_at: expires.value === undefined ? null : expires.value,
    ownerKey: ownerSecret,
  });
});

app.patch("/api/shares/:token", (req, res) => {
  if (!requireOwner(req, res)) return;
  expireStaleShares();
  const token = String(req.params.token || "");
  if (!isValidShareToken(token)) return res.status(400).json({ error: "Invalid token" });
  const row = db.prepare("SELECT * FROM shares WHERE token = ?").get(token);
  if (!row) return res.status(404).json({ error: "Share not found" });
  const updates = [];
  const values = [];
  if (req.body?.isActive !== undefined) {
    updates.push("is_active = ?");
    values.push(req.body.isActive ? 1 : 0);
  }
  if (req.body?.mode === "live" || req.body?.mode === "snapshot") {
    updates.push("mode = ?");
    values.push(req.body.mode);
  }
  if (req.body?.owner_label !== undefined) {
    updates.push("owner_label = ?");
    values.push(sanitizeOwnerLabel(req.body.owner_label));
  }
  const expires = parseShareExpiresAt(req.body?.expires_at);
  if (!expires.ok) return res.status(400).json({ error: expires.error });
  if (isExpiredIso(row.expires_at) && expires.value === undefined) {
    return res.status(410).json({ error: "This link has expired." });
  }
  if (expires.value !== undefined) {
    updates.push("expires_at = ?");
    values.push(expires.value);
  }
  if (updates.length === 0) {
    return res.json({ ok: true });
  }
  updates.push("updated_at = ?");
  values.push(nowIso());
  values.push(token);
  db.prepare(`UPDATE shares SET ${updates.join(", ")} WHERE token = ?`).run(...values);
  res.json({ ok: true });
});

app.post("/api/shares/:token/regenerate", (req, res) => {
  if (!requireOwner(req, res)) return;
  expireStaleShares();
  const token = String(req.params.token || "");
  if (!isValidShareToken(token)) return res.status(400).json({ error: "Invalid token" });
  const row = db.prepare("SELECT * FROM shares WHERE token = ?").get(token);
  if (!row) return res.status(404).json({ error: "Share not found" });
  const newToken = generateShareToken();
  const now = nowIso();
  const nextExpiry = row.expires_at && !isExpiredIso(row.expires_at) ? row.expires_at : null;
  db.prepare("UPDATE shares SET is_active = 0, updated_at = ? WHERE token = ?").run(now, token);
  db.prepare(
    `INSERT INTO shares (token, mode, is_active, payload, payload_version, owner_label, expires_at, last_published_at, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newToken,
    row.mode,
    row.payload,
    row.payload_version,
    row.owner_label,
    nextExpiry,
    row.last_published_at,
    now,
    now
  );
  const ownerSecret = getOwnerSecret();
  res.json({
    shareUrl: buildViewerShareUrl(req, newToken),
    shareToken: newToken,
    expires_at: nextExpiry,
    ownerKey: ownerSecret,
  });
});

app.post("/api/shares/:token/publish", (req, res) => {
  if (!requireOwner(req, res)) return;
  expireStaleShares();
  const token = String(req.params.token || "");
  if (!isValidShareToken(token)) return res.status(400).json({ error: "Invalid token" });
  const row = db.prepare("SELECT * FROM shares WHERE token = ?").get(token);
  if (!row) return res.status(404).json({ error: "Share not found" });
  if (isExpiredIso(row.expires_at)) {
    db.prepare("UPDATE shares SET is_active = 0, updated_at = ? WHERE token = ?").run(nowIso(), token);
    return res.status(410).json({ error: "This link has expired." });
  }
  const payload = req.body?.payload;
  const payloadCheck = validateSharePayload(payload);
  if (!payloadCheck.ok) return res.status(400).json({ error: payloadCheck.error });
  const payloadString = safeJsonStringify(payload);
  if (!payloadString) {
    return res.status(400).json({ error: "Invalid payload" });
  }
  if (Buffer.byteLength(payloadString, "utf8") > MAX_SHARE_PAYLOAD_BYTES) {
    return res.status(400).json({ error: "Payload too large" });
  }
  const version = req.body?.schema_version || payload.schema_version || null;
  const ownerLabel = sanitizeOwnerLabel(req.body?.owner_label) || row.owner_label || null;
  db.prepare(
    "UPDATE shares SET payload = ?, payload_version = ?, owner_label = ?, last_published_at = ?, updated_at = ? WHERE token = ?"
  ).run(payloadString, version, ownerLabel, nowIso(), nowIso(), token);
  res.json({ ok: true });
});

app.post("/api/shares/:token/publish-current", (req, res) => {
  if (!requireOwner(req, res)) return;
  expireStaleShares();
  const token = String(req.params.token || "");
  if (!isValidShareToken(token)) return res.status(400).json({ error: "Invalid token" });
  const row = db.prepare("SELECT * FROM shares WHERE token = ?").get(token);
  if (!row) return res.status(404).json({ error: "Share not found" });
  if (isExpiredIso(row.expires_at)) {
    db.prepare("UPDATE shares SET is_active = 0, updated_at = ? WHERE token = ?").run(nowIso(), token);
    return res.status(410).json({ error: "This link has expired." });
  }
  const parsed = parseSharePublishYearMonth(req.body || {});
  if (!parsed) {
    return res.status(400).json({ error: "Invalid year/month" });
  }
  const ownerLabel = sanitizeOwnerLabel(req.body?.owner_label) || row.owner_label || null;
  const payload = buildSharePayloadFromMonth(parsed.year, parsed.month, {
    ownerLabel,
    includeAmounts: req.body?.include_amounts,
    includeNotes: req.body?.include_notes,
    includeCategories: req.body?.include_categories,
  });
  const payloadCheck = validateSharePayload(payload);
  if (!payloadCheck.ok) return res.status(400).json({ error: payloadCheck.error });
  const payloadString = safeJsonStringify(payload);
  if (!payloadString) return res.status(400).json({ error: "Invalid payload" });
  if (Buffer.byteLength(payloadString, "utf8") > MAX_SHARE_PAYLOAD_BYTES) {
    return res.status(400).json({ error: "Payload too large" });
  }
  db.prepare(
    "UPDATE shares SET payload = ?, payload_version = ?, owner_label = ?, last_published_at = ?, updated_at = ? WHERE token = ?"
  ).run(payloadString, payload.schema_version || "1", ownerLabel, nowIso(), nowIso(), token);
  res.json({
    ok: true,
    period: payload.period,
    items: payload.items.length,
    shareToken: token,
  });
});

app.get("/api/shares/:token", (req, res) => {
  expireStaleShares();
  if (!rateLimitShareLookup(req, res)) return;
  const token = String(req.params.token || "");
  if (!isValidShareToken(token)) return res.status(400).json({ error: "Invalid token" });
  const row = db.prepare("SELECT * FROM shares WHERE token = ?").get(token);
  if (!row) return res.status(404).json({ error: "This link is invalid or has been disabled." });
  if (!row.is_active) return res.status(410).json({ error: "This link has been disabled by the owner." });
  if (row.expires_at && row.expires_at < nowIso()) {
    return res.status(410).json({ error: "This link has expired." });
  }
  const etag = computeShareEtag(row);
  res.setHeader("ETag", etag);
  if (row.updated_at) {
    const modified = new Date(row.updated_at);
    if (!Number.isNaN(modified.valueOf())) {
      res.setHeader("Last-Modified", modified.toUTCString());
    }
  }
  const ifNoneMatch = String(req.headers["if-none-match"] || "").trim();
  if (ifNoneMatch && ifNoneMatch === etag) {
    return res.status(304).end();
  }
  const payload = safeJsonParse(row.payload);
  if (!payload) return res.status(404).json({ error: "No shared data available yet." });
  res.json({
    payload,
    mode: row.mode,
    expiresAt: row.expires_at || null,
    ownerLabel: row.owner_label || null,
    lastPublishedAt: row.last_published_at || null,
  });
});

app.get("/api/month-settings", (req, res) => {
  const parsed = parseYearMonth(req);
  if (!parsed) return res.status(400).json({ error: "Invalid year/month" });
  const row = db
    .prepare("SELECT * FROM month_settings WHERE year = ? AND month = ?")
    .get(parsed.year, parsed.month);
  res.json({
    year: parsed.year,
    month: parsed.month,
    cash_start: row ? Number(row.cash_start || 0) : 0,
  });
});

app.post("/api/month-settings", (req, res) => {
  const year = Number(req.body?.year);
  const month = Number(req.body?.month);
  const cashStart = Number(req.body?.cash_start);
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    return res.status(400).json({ error: "Invalid year/month" });
  }
  if (!Number.isFinite(cashStart) || cashStart < 0) {
    return res.status(400).json({ error: "cash_start must be >= 0" });
  }
  db.prepare(
    `INSERT INTO month_settings (year, month, cash_start, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(year, month) DO UPDATE SET cash_start = excluded.cash_start, updated_at = excluded.updated_at`
  ).run(year, month, cashStart, nowIso());
  res.json({ ok: true });
});

app.get("/api/llm/qwen/oauth/status", async (req, res) => {
  const oauth = await getQwenOauthFresh();
  const connected = oauth && !qwenOauth.isTokenExpired(oauth);
  const providerState = getLlmProviderState();
  const activeProvider = normalizeProviderName(providerState.active_provider || "qwen-oauth");
  res.json({
    connected: !!connected,
    expires_at: oauth?.expiry_date || null,
    resource_url: oauth?.resource_url || null,
    provider: "qwen-oauth",
    active: activeProvider === "qwen-oauth",
  });
});

app.get("/api/llm/qwen/oauth/last", (req, res) => {
  const row = db
    .prepare(
      `SELECT id, user_code, verification_uri, verification_uri_complete, interval_seconds, expires_at, status
       FROM oauth_device_sessions
       WHERE provider = 'qwen' AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get();

  if (!row) return res.status(404).json({ status: "none" });
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return res.status(410).json({ status: "expired" });
  }
  return res.json({
    status: "pending",
    session_id: row.id,
    user_code: row.user_code,
    verification_uri: row.verification_uri,
    verification_uri_complete: row.verification_uri_complete,
    interval_seconds: row.interval_seconds,
    expires_at: row.expires_at,
  });
});

app.post("/api/llm/qwen/oauth/start", async (req, res) => {
  db.prepare(
    "UPDATE oauth_device_sessions SET status = 'superseded' WHERE provider = 'qwen' AND status = 'pending'"
  ).run();

  try {
    const payload = await qwenOauth.requestDeviceAuthorization();
    const expiresIn = Number(payload.expires_in || 600);
    const interval = Number(payload.interval || 5);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const sessionId = randomUUID();

    db.prepare(
      `INSERT INTO oauth_device_sessions (
        id, provider, device_code, user_code, verification_uri, verification_uri_complete,
        code_verifier, interval_seconds, expires_at, status, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sessionId,
      "qwen",
      payload.device_code,
      payload.user_code || null,
      payload.verification_uri || null,
      payload.verification_uri_complete || null,
      payload.code_verifier,
      interval,
      expiresAt,
      "pending",
      null,
      nowIso()
    );

    res.json({
      session_id: sessionId,
      user_code: payload.user_code,
      verification_uri: payload.verification_uri,
      verification_uri_complete: payload.verification_uri_complete,
      expires_at: expiresAt,
      interval_seconds: interval,
    });
  } catch (err) {
    res.status(502).json({ error: err.message || "OAuth start failed" });
  }
});

app.post("/api/llm/qwen/oauth/poll", async (req, res) => {
  const sessionId = String(req.body?.session_id || "").trim();
  if (!sessionId) return res.status(400).json({ error: "session_id required" });

  const session = db
    .prepare("SELECT * FROM oauth_device_sessions WHERE id = ? AND provider = 'qwen'")
    .get(sessionId);
  if (!session) return res.status(404).json({ error: "OAuth session not found" });

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.prepare("UPDATE oauth_device_sessions SET status = 'expired' WHERE id = ?").run(
      sessionId
    );
    return res.json({ status: "expired", message: "Device code expired." });
  }

  try {
    const result = await qwenOauth.pollDeviceToken(
      session.device_code,
      session.code_verifier
    );
    if (result.status === "pending") {
      let interval = session.interval_seconds;
      if (result.slow_down) {
        interval = Math.min(interval + 5, 30);
        db.prepare("UPDATE oauth_device_sessions SET interval_seconds = ? WHERE id = ?").run(
          interval,
          sessionId
        );
      }
      return res.json({ status: "pending", interval_seconds: interval });
    }

    if (result.status === "error") {
      db.prepare("UPDATE oauth_device_sessions SET status = 'error', error = ? WHERE id = ?").run(
        result.error_description || result.error || "OAuth error",
        sessionId
      );
      return res.json({
        status: "error",
        message: result.error_description || result.error || "OAuth error",
      });
    }

    const tokenData = result.token || {};
    const oauthSettings = qwenOauth.buildOAuthSettings(tokenData);
    setQwenOauthSettings(oauthSettings);
    const providerState = getLlmProviderState();
    providerState.active_provider = "qwen-oauth";
    providerState.providers["qwen-oauth"] = {
      ...providerState.providers["qwen-oauth"],
      connected: true,
      connected_at: nowIso(),
      last_error: null,
    };
    setLlmProviderState(providerState);

    db.prepare("UPDATE oauth_device_sessions SET status = 'approved', error = NULL WHERE id = ?").run(
      sessionId
    );

    res.json({
      status: "success",
      expires_at: oauthSettings.expiry_date,
      resource_url: oauthSettings.resource_url,
    });
  } catch (err) {
    db.prepare("UPDATE oauth_device_sessions SET status = 'error', error = ? WHERE id = ?").run(
      err.message || "OAuth error",
      sessionId
    );
    res.json({ status: "error", message: err.message || "OAuth error" });
  }
});

app.delete("/api/llm/qwen/oauth", (req, res) => {
  setMeta("qwen_oauth", "");
  const providerState = getLlmProviderState();
  providerState.providers["qwen-oauth"] = {
    ...providerState.providers["qwen-oauth"],
    connected: false,
    connected_at: null,
    last_error: null,
  };
  if (providerState.active_provider === "qwen-oauth") {
    providerState.active_provider = "openai";
    if (!getProviderCredential("openai")) {
      providerState.active_provider = "anthropic";
      if (!getProviderCredential("anthropic")) {
        providerState.active_provider = "qwen-oauth";
      }
    }
  }
  setLlmProviderState(providerState);
  res.json({ ok: true });
});

app.get("/api/llm/providers/status", async (req, res) => {
  const status = await buildProviderStatus();
  setLlmProviderState(status);
  const activeProvider = normalizeProviderName(status.active_provider || "qwen-oauth");
  const activeRow = status.providers?.[activeProvider] || {};
  res.json({
    ok: true,
    active_provider: activeProvider,
    active_model: activeRow.model || null,
    providers: status.providers,
    updated_at: status.updated_at || null,
  });
});

app.post("/api/llm/providers/select", async (req, res) => {
  const provider = normalizeProviderName(req.body?.provider);
  if (!validProviderName(provider)) {
    return res.status(400).json({ error: "Unsupported provider." });
  }
  const state = await buildProviderStatus();
  const next = { ...state, active_provider: provider };
  if (req.body?.model !== undefined) {
    const model = String(req.body.model || "").trim();
    if (!model) return res.status(400).json({ error: "model is required when provided." });
    next.providers[provider] = {
      ...(next.providers[provider] || {}),
      model,
    };
  }
  if (provider !== "qwen-oauth") {
    const credential = getProviderCredential(provider);
    if (!credential) {
      next.providers[provider] = {
        ...(next.providers[provider] || {}),
        connected: false,
        configured: false,
        last_error: "Provider key is not configured.",
      };
      setLlmProviderState(next);
      return res.status(400).json({
        error: "Provider key is not configured. Connect with API key first.",
        state: next,
      });
    }
    next.providers[provider] = {
      ...(next.providers[provider] || {}),
      configured: true,
      connected: true,
      last_error: null,
    };
  }
  setLlmProviderState(next);
  const output = await buildProviderStatus();
  res.json({ ok: true, state: output });
});

app.post("/api/llm/providers/connect/api-key", async (req, res) => {
  const provider = normalizeProviderName(req.body?.provider);
  if (!["openai", "anthropic"].includes(provider)) {
    return res.status(400).json({ error: "provider must be openai or anthropic." });
  }
  const validation = validateApiKeyInput(provider, req.body?.api_key);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }
  const model = String(req.body?.model || "").trim() || (provider === "openai" ? OPENAI_DEFAULT_MODEL : ANTHROPIC_DEFAULT_MODEL);
  const baseUrl = String(req.body?.base_url || "").trim() || (provider === "openai" ? OPENAI_BASE_URL : ANTHROPIC_BASE_URL);
  const testResult = await testProviderConnection(provider, {
    apiKey: validation.apiKey,
    model,
    baseUrl,
  });
  if (!testResult.ok) {
    const state = getLlmProviderState();
    state.providers[provider] = {
      ...(state.providers[provider] || {}),
      configured: false,
      connected: false,
      last_error: testResult.error || "Connection test failed.",
    };
    setLlmProviderState(state);
    return res.status(400).json({ error: testResult.error || "Connection test failed." });
  }
  setProviderCredential(provider, {
    api_key: validation.apiKey,
    model,
    base_url: baseUrl,
  });
  const state = getLlmProviderState();
  state.active_provider = provider;
  state.providers[provider] = {
    ...(state.providers[provider] || {}),
    model: testResult.model || model,
    configured: true,
    connected: true,
    connected_at: nowIso(),
    key_hint: getKeyHint(validation.apiKey),
    last_error: null,
  };
  setLlmProviderState(state);
  const output = await buildProviderStatus();
  res.json({ ok: true, provider, state: output });
});

app.post("/api/llm/providers/test", async (req, res) => {
  const state = await buildProviderStatus();
  const provider = normalizeProviderName(req.body?.provider || state.active_provider);
  if (!validProviderName(provider)) {
    return res.status(400).json({ error: "Unsupported provider." });
  }
  if (provider === "qwen-oauth") {
    const oauth = await getQwenOauthFresh();
    const connected = !!oauth && !qwenOauth.isTokenExpired(oauth);
    return res.json({
      ok: connected,
      provider,
      connected,
      error: connected ? null : "Qwen login required.",
    });
  }
  const credential = getProviderCredential(provider);
  if (!credential) {
    return res.status(400).json({ ok: false, provider, error: "Provider key not configured." });
  }
  const result = await testProviderConnection(provider, {
    apiKey: credential.api_key,
    model: credential.model || state.providers?.[provider]?.model || null,
    baseUrl: credential.base_url || null,
  });
  if (!result.ok) {
    const next = getLlmProviderState();
    next.providers[provider] = {
      ...(next.providers[provider] || {}),
      connected: false,
      last_error: result.error || "Provider test failed.",
    };
    setLlmProviderState(next);
    return res.status(400).json({ ok: false, provider, error: result.error || "Provider test failed." });
  }
  const next = getLlmProviderState();
  next.providers[provider] = {
    ...(next.providers[provider] || {}),
    connected: true,
    connected_at: nowIso(),
    last_error: null,
    configured: true,
  };
  setLlmProviderState(next);
  return res.json({ ok: true, provider, connected: true, model: result.model || null });
});

app.delete("/api/llm/providers/disconnect", (req, res) => {
  const provider = normalizeProviderName(req.body?.provider || req.query.provider || "");
  const state = getLlmProviderState();
  const targets = provider ? [provider] : [state.active_provider];
  for (const target of targets) {
    if (!validProviderName(target)) continue;
    if (target === "qwen-oauth") {
      setMeta("qwen_oauth", "");
      state.providers["qwen-oauth"] = {
        ...(state.providers["qwen-oauth"] || {}),
        connected: false,
        connected_at: null,
        last_error: null,
      };
      continue;
    }
    setProviderCredential(target, null);
    state.providers[target] = {
      ...(state.providers[target] || {}),
      configured: false,
      connected: false,
      connected_at: null,
      key_hint: null,
      last_error: null,
    };
  }
  if (!validProviderName(state.active_provider) || state.active_provider === provider) {
    state.active_provider = "qwen-oauth";
  }
  setLlmProviderState(state);
  res.json({ ok: true, state });
});

app.get("/api/sinking-funds", (req, res) => {
  const parsed = parseYearMonth(req);
  const now = new Date();
  const year = parsed?.year ?? now.getFullYear();
  const month = parsed?.month ?? now.getMonth() + 1;
  const includeInactive =
    req.query.include_inactive === "1" || req.query.include_inactive === "true";
  const funds = getSinkingFunds(year, month, includeInactive);
  res.json(funds);
});

app.get("/api/sinking-events", (req, res) => {
  const fundId = String(req.query.fund_id || "").trim();
  if (!fundId) return res.status(400).json({ error: "fund_id required" });
  const events = db
    .prepare(
      `SELECT id, fund_id, amount, type, event_date, note, created_at
       FROM sinking_events
       WHERE fund_id = ?
       ORDER BY event_date DESC, created_at DESC`
    )
    .all(fundId);
  res.json(events);
});

app.post("/api/apply-templates", (req, res) => {
  const parsed = parseYearMonth(req);
  if (!parsed) return res.status(400).json({ error: "Invalid year/month" });

  ensureMonth(parsed.year, parsed.month);

  const templates = db.prepare("SELECT * FROM templates").all();
  const byId = new Map(templates.map((t) => [t.id, t]));
  const instances = db
    .prepare("SELECT * FROM instances WHERE year = ? AND month = ?")
    .all(parsed.year, parsed.month);

  const update = db.prepare(
    `UPDATE instances
     SET name_snapshot = ?, category_snapshot = ?, amount = ?, due_date = ?, autopay_snapshot = ?, essential_snapshot = ?, updated_at = ?
     WHERE id = ?`
  );

  const stamp = nowIso();
  const run = db.transaction(() => {
    for (const instance of instances) {
      const template = byId.get(instance.template_id);
      if (!template) continue;
      const dueDay = ledger.clampDueDay(parsed.year, parsed.month, template.due_day);
      const dueDate = ledger.toDateString(parsed.year, parsed.month, dueDay);
      update.run(
        template.name,
        template.category || null,
        template.amount_default,
        dueDate,
        template.autopay ? 1 : 0,
        template.essential ? 1 : 0,
        stamp,
        instance.id
      );
    }
  });

  run();
  res.json({ ok: true });
});

app.get("/api/export/month.csv", (req, res) => {
  const parsed = parseYearMonth(req);
  if (!parsed) return res.status(400).json({ error: "Invalid year/month" });

  const rows = attachPayments(
    db
      .prepare(
        "SELECT * FROM instances WHERE year = ? AND month = ? ORDER BY due_date"
      )
      .all(parsed.year, parsed.month)
  );

  const header = [
    "instance_id",
    "template_id",
    "name",
    "category",
    "amount",
    "amount_paid",
    "amount_remaining",
    "due_date",
    "status",
    "paid_date",
    "note",
    "autopay",
    "essential",
  ];

  const escapeCsv = (value) => {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (/[,"\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.id,
        row.template_id,
        row.name_snapshot,
        row.category_snapshot || "",
        row.amount,
        row.amount_paid || 0,
        row.amount_remaining || 0,
        row.due_date,
        row.status_derived || row.status,
        row.paid_date || "",
        row.note || "",
        row.autopay_snapshot ? 1 : 0,
        row.essential_snapshot ? 1 : 0,
      ]
        .map(escapeCsv)
        .join(",")
    );
  }

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="au_jour_le_jour_${parsed.year}-${ledger.pad2(
      parsed.month
    )}.csv"`
  );
  res.send(lines.join("\n"));
});

app.get("/api/export/sqlite", (req, res) => {
  if (!fs.existsSync(dbFile)) {
    return res.status(404).json({ error: "Database not found" });
  }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    "attachment; filename=\"au_jour_le_jour.sqlite\""
  );
  const stream = fs.createReadStream(dbFile);
  stream.on("error", () => res.status(500).end());
  stream.pipe(res);
});

app.get("/api/export/backup.json", (req, res) => {
  const templates = db.prepare("SELECT * FROM templates").all();
  const instances = db.prepare("SELECT * FROM instances").all();
  const payments = db.prepare("SELECT * FROM payment_events").all();
  const instanceEvents = db.prepare("SELECT * FROM instance_events").all();
  const monthSettings = db.prepare("SELECT * FROM month_settings").all();
  const sinkingFunds = db.prepare("SELECT * FROM sinking_funds").all();
  const sinkingEvents = db.prepare("SELECT * FROM sinking_events").all();
  const settings = getMetaJson("settings") || {
    defaults: { sort: "due_date", dueSoonDays: 7, defaultPeriod: "month" },
    categories: [],
  };
  res.json({
    app: "au-jour-le-jour",
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    exported_at: nowIsoLocal(),
    templates: templates.map(normalizeTemplate),
    instances: instances.map(normalizeInstance),
    payment_events: payments,
    instance_events: instanceEvents,
    month_settings: monthSettings,
    sinking_funds: sinkingFunds.map(normalizeSinkingFund),
    sinking_events: sinkingEvents,
    settings,
  });
});

app.post("/api/import/backup", (req, res) => {
  const payload = req.body || {};
  const incomingTemplates = Array.isArray(payload.templates)
    ? payload.templates
    : [];
  const incomingInstances = Array.isArray(payload.instances)
    ? payload.instances
    : [];
  const incomingPayments = Array.isArray(payload.payment_events)
    ? payload.payment_events
    : [];
  const incomingInstanceEvents = Array.isArray(payload.instance_events)
    ? payload.instance_events
    : [];
  const incomingMonthSettings = Array.isArray(payload.month_settings)
    ? payload.month_settings
    : [];
  const incomingSinkingFunds = Array.isArray(payload.sinking_funds)
    ? payload.sinking_funds
    : [];
  const incomingSinkingEvents = Array.isArray(payload.sinking_events)
    ? payload.sinking_events
    : [];
  const incomingSettings =
    payload.settings && typeof payload.settings === "object"
      ? payload.settings
      : null;

  const existingTemplates = db.prepare("SELECT * FROM templates").all();
  const existingById = new Map(existingTemplates.map((t) => [t.id, t]));
  const idMap = new Map();

  const insertTemplateWithId = db.prepare(
    `INSERT INTO templates (
      id, name, category, amount_default, due_day, autopay, essential, active, default_note,
      match_payee_key, match_amount_tolerance, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertTemplate = db.prepare(
    `INSERT INTO templates (
      id, name, category, amount_default, due_day, autopay, essential, active, default_note,
      match_payee_key, match_amount_tolerance, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertSinkingFund = db.prepare(
    `INSERT OR IGNORE INTO sinking_funds (
      id, name, category, target_amount, due_date, cadence, months_per_cycle, essential, active, auto_contribute,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertSinkingEvent = db.prepare(
    `INSERT OR IGNORE INTO sinking_events (
      id, fund_id, amount, type, event_date, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const insertInstance = db.prepare(
    `INSERT OR IGNORE INTO instances (
      id, template_id, year, month, name_snapshot, category_snapshot, amount, due_date,
      autopay_snapshot, essential_snapshot, status, paid_date, note, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertPayment = db.prepare(
    `INSERT OR IGNORE INTO payment_events (
      id, instance_id, amount, paid_date, created_at
    ) VALUES (?, ?, ?, ?, ?)`
  );

  const insertInstanceEvent = db.prepare(
    `INSERT OR IGNORE INTO instance_events (
      id, instance_id, type, detail, created_at
    ) VALUES (?, ?, ?, ?, ?)`
  );

  const upsertMonthSettings = db.prepare(
    `INSERT INTO month_settings (year, month, cash_start, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(year, month) DO UPDATE SET cash_start = excluded.cash_start, updated_at = excluded.updated_at`
  );

  const stamp = nowIso();
  const run = db.transaction(() => {
    for (const tmpl of incomingTemplates) {
      const incomingId = tmpl.id ? String(tmpl.id) : null;
      const normalized = validateTemplateInput(tmpl);
      if (normalized.error) continue;

      if (incomingId && existingById.has(incomingId)) {
        const existing = existingById.get(incomingId);
        const same =
          existing.name === normalized.name &&
          (existing.category || null) === (normalized.category || null) &&
          Number(existing.amount_default) === Number(normalized.amount_default) &&
          Number(existing.due_day) === Number(normalized.due_day) &&
          Number(existing.autopay) === Number(normalized.autopay) &&
          Number(existing.essential) === Number(normalized.essential) &&
          Number(existing.active) === Number(normalized.active) &&
          (existing.default_note || null) === (normalized.default_note || null) &&
          (existing.match_payee_key || null) === (normalized.match_payee_key || null) &&
          Number(existing.match_amount_tolerance || 0) ===
            Number(normalized.match_amount_tolerance || 0);
        if (same) {
          idMap.set(incomingId, incomingId);
          continue;
        }
      }

      const templateId = incomingId && !existingById.has(incomingId) ? incomingId : randomUUID();
      insertTemplateWithId.run(
        templateId,
        normalized.name,
        normalized.category,
        normalized.amount_default,
        normalized.due_day,
        normalized.autopay,
        normalized.essential,
        normalized.active,
        normalized.default_note,
        normalized.match_payee_key,
        normalized.match_amount_tolerance,
        tmpl.created_at || stamp,
        tmpl.updated_at || stamp
      );
      idMap.set(incomingId, templateId);
      existingById.set(templateId, { ...normalized, id: templateId });
    }

    for (const inst of incomingInstances) {
      const incomingTemplateId = inst.template_id ? String(inst.template_id) : null;
      const mappedTemplateId = idMap.get(incomingTemplateId) || incomingTemplateId;
      if (!mappedTemplateId) continue;

      const year = Number(inst.year);
      const month = Number(inst.month);
      if (!Number.isInteger(year) || !Number.isInteger(month)) continue;

      const instanceId = inst.id ? String(inst.id) : randomUUID();

      insertInstance.run(
        instanceId,
        mappedTemplateId,
        year,
        month,
        inst.name_snapshot || inst.name || "",
        inst.category_snapshot || inst.category || null,
        Number(inst.amount ?? 0),
        inst.due_date,
        inst.autopay_snapshot ? 1 : 0,
        inst.essential_snapshot ? 1 : 0,
        ["pending", "paid", "skipped"].includes(inst.status) ? inst.status : "pending",
        inst.paid_date || null,
        inst.note || null,
        inst.created_at || stamp,
        inst.updated_at || stamp
      );
    }

    for (const payment of incomingPayments) {
      const paymentId = payment.id ? String(payment.id) : randomUUID();
      const instanceId = payment.instance_id ? String(payment.instance_id) : null;
      if (!instanceId) continue;
      const amount = Number(payment.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const paidDate = payment.paid_date;
      if (!paidDate || validateDateString(paidDate, "paid_date")) continue;
      insertPayment.run(
        paymentId,
        instanceId,
        amount,
        paidDate,
        payment.created_at || stamp
      );
    }

    for (const event of incomingInstanceEvents) {
      const eventId = event.id ? String(event.id) : randomUUID();
      const instanceId = event.instance_id ? String(event.instance_id) : null;
      if (!instanceId) continue;
      const type = String(event.type || "updated");
      let detail = null;
      if (event.detail !== undefined && event.detail !== null) {
        detail = typeof event.detail === "string" ? event.detail : JSON.stringify(event.detail);
      }
      insertInstanceEvent.run(
        eventId,
        instanceId,
        type,
        detail,
        event.created_at || stamp
      );
    }

    for (const setting of incomingMonthSettings) {
      const year = Number(setting.year);
      const month = Number(setting.month);
      const cashStart = Number(setting.cash_start);
      if (!Number.isInteger(year) || !Number.isInteger(month)) continue;
      if (!Number.isFinite(cashStart) || cashStart < 0) continue;
      upsertMonthSettings.run(
        year,
        month,
        cashStart,
        setting.updated_at || stamp
      );
    }

    if (incomingSettings) {
      const payload = {
        defaults: {
          sort: incomingSettings.defaults?.sort || "due_date",
          dueSoonDays: Number(incomingSettings.defaults?.dueSoonDays || 7),
          defaultPeriod: incomingSettings.defaults?.defaultPeriod || "month",
        },
        categories: Array.isArray(incomingSettings.categories)
          ? incomingSettings.categories.map((c) => String(c || "").trim()).filter(Boolean)
          : [],
      };
      setMetaJson("settings", payload);
    }

    for (const fund of incomingSinkingFunds) {
      const fundId = String(fund.id || "").trim();
      if (!fundId) continue;
      const targetAmount = Number(fund.target_amount);
      const monthsPer = Number(fund.months_per_cycle || 1);
      if (!Number.isFinite(targetAmount) || targetAmount < 0) continue;
      if (!Number.isInteger(monthsPer) || monthsPer < 1) continue;
      insertSinkingFund.run(
        fundId,
        fund.name,
        fund.category || null,
        targetAmount,
        fund.due_date,
        fund.cadence || "yearly",
        monthsPer,
        fund.essential ? 1 : 0,
        fund.active ? 1 : 0,
        fund.auto_contribute ? 1 : 0,
        fund.created_at || stamp,
        fund.updated_at || stamp
      );
    }

    for (const event of incomingSinkingEvents) {
      const eventId = String(event.id || "").trim();
      const fundId = String(event.fund_id || "").trim();
      if (!eventId || !fundId) continue;
      const amount = Number(event.amount);
      if (!Number.isFinite(amount) || amount < 0) continue;
      insertSinkingEvent.run(
        eventId,
        fundId,
        amount,
        event.type || "CONTRIBUTION",
        event.event_date,
        event.note || null,
        event.created_at || stamp
      );
    }
  });

  run();
  res.json({ ok: true });
});

app.get("/api/v1/summary", (req, res) => {
  const parsed = parseYearMonth(req);
  if (!parsed) return res.status(400).json({ error: "Invalid year/month" });
  ensureMonth(parsed.year, parsed.month);
  const essentialsOnly = parseEssentialsOnly(req.query.essentials_only);
  const instances = getInstances(parsed.year, parsed.month);
  const summary = ledger.computeSummary(instances, {
    year: parsed.year,
    month: parsed.month,
    essentialsOnly,
    todayDate: new Date(),
  });
  const funds = getSinkingFunds(parsed.year, parsed.month, false);
  const futureReserved = funds.reduce(
    (sum, fund) => sum + Math.max(0, Number(fund.balance || 0)),
    0
  );

  res.json({
    app: "au-jour-le-jour",
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    version: APP_VERSION,
    period: `${parsed.year}-${ledger.pad2(parsed.month)}`,
    filters: { essentials_only: essentialsOnly },
    required_month: summary.required_month,
    paid_month: summary.paid_month,
    remaining_month: summary.remaining_month,
    need_daily_exact: summary.need_daily_exact,
    need_weekly_exact: summary.need_weekly_exact,
    free_for_month: summary.free_for_month,
    future_reserved: futureReserved,
    generated_at: nowIsoLocal(),
  });
});

app.get("/api/v1/month", (req, res) => {
  const parsed = parseYearMonth(req);
  if (!parsed) return res.status(400).json({ error: "Invalid year/month" });
  ensureMonth(parsed.year, parsed.month);
  const essentialsOnly = parseEssentialsOnly(req.query.essentials_only);
  const instances = getInstances(parsed.year, parsed.month);
  const filtered = essentialsOnly
    ? instances.filter((item) => item.essential_snapshot)
    : instances;

  res.json({
    app: "au-jour-le-jour",
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    period: `${parsed.year}-${ledger.pad2(parsed.month)}`,
    generated_at: nowIsoLocal(),
    items: filtered.map((item) => ({
      instance_id: item.id,
      template_id: item.template_id,
      name: item.name_snapshot,
      category: item.category_snapshot,
      amount: item.amount,
      amount_paid: item.amount_paid || 0,
      amount_remaining: item.amount_remaining || 0,
      due_date: item.due_date,
      status: item.status_derived || item.status,
      paid_date: item.paid_date,
      autopay: item.autopay_snapshot,
      essential: item.essential_snapshot,
      note: item.note,
    })),
  });
});

app.get("/api/v1/templates", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM templates ORDER BY name COLLATE NOCASE")
    .all()
    .map(normalizeTemplate);

  res.json({
    app: "au-jour-le-jour",
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    generated_at: nowIsoLocal(),
    templates: rows,
  });
});

app.get("/api/v1/sinking-funds", (req, res) => {
  const parsed = parseYearMonth(req);
  const now = new Date();
  const year = parsed?.year ?? now.getFullYear();
  const month = parsed?.month ?? now.getMonth() + 1;
  const funds = getSinkingFunds(year, month, false);
  res.json({
    app: "au-jour-le-jour",
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    period: `${year}-${ledger.pad2(month)}`,
    generated_at: nowIsoLocal(),
    funds,
  });
});

app.get("/api/v1/sinking-events", (req, res) => {
  const fundId = String(req.query.fund_id || "").trim();
  if (!fundId) return res.status(400).json({ error: "fund_id required" });
  const events = db
    .prepare(
      `SELECT id, fund_id, amount, type, event_date, note, created_at
       FROM sinking_events
       WHERE fund_id = ?
       ORDER BY event_date DESC, created_at DESC`
    )
    .all(fundId);
  res.json({
    app: "au-jour-le-jour",
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    generated_at: nowIsoLocal(),
    events,
  });
});

app.get("/api/v1/actions/:id", (req, res) => {
  const actionId = String(req.params.id || "").trim();
  if (!actionId) return res.status(400).json({ ok: false, error: "action id is required" });
  const row = db.prepare("SELECT * FROM actions WHERE id = ?").get(actionId);
  if (!row) return res.status(404).json({ ok: false, error: "Action not found" });
  res.json({
    ok: true,
    action: {
      action_id: row.id,
      type: row.type,
      status: row.status,
      created_at: row.created_at,
      payload: safeJsonParse(row.payload),
      result: parseStoredActionResult(row),
    },
  });
});

app.get("/api/v1/actions", (req, res) => {
  const limitRaw = Number(req.query.limit || 50);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;
  const statusFilter = String(req.query.status || "").trim().toLowerCase();
  const validStatuses = new Set(["pending", "ok", "error"]);
  let rows;
  if (statusFilter && validStatuses.has(statusFilter)) {
    rows = db
      .prepare(
        "SELECT id, type, status, created_at, payload, result FROM actions WHERE status = ? ORDER BY datetime(created_at) DESC LIMIT ?"
      )
      .all(statusFilter, limit);
  } else {
    rows = db
      .prepare(
        "SELECT id, type, status, created_at, payload, result FROM actions ORDER BY datetime(created_at) DESC LIMIT ?"
      )
      .all(limit);
  }
  const actions = rows.map((row) => ({
    action_id: row.id,
    type: row.type,
    status: row.status,
    created_at: row.created_at,
    payload: safeJsonParse(row.payload),
    result: parseStoredActionResult(row),
  }));
  res.json({
    ok: true,
    actions,
    count: actions.length,
    filter: statusFilter && validStatuses.has(statusFilter) ? { status: statusFilter } : null,
  });
});

app.post("/api/v1/actions", (req, res) => {
  const action = req.body || {};
  const actionId = String(action.action_id || "").trim();
  const type = String(action.type || "").trim();

  if (!actionId) return res.status(400).json({ ok: false, error: "action_id is required" });
  if (!type) return res.status(400).json({ ok: false, error: "type is required" });

  const existing = db.prepare("SELECT * FROM actions WHERE id = ?").get(actionId);
  if (existing) {
    return sendStoredActionResponse(res, existing);
  }

  try {
    db.prepare(
      "INSERT INTO actions (id, type, payload, created_at, status, result) VALUES (?, ?, ?, ?, 'pending', NULL)"
    ).run(actionId, type, JSON.stringify(action), nowIso());
  } catch (err) {
    const raced = db.prepare("SELECT * FROM actions WHERE id = ?").get(actionId);
    if (raced) {
      return sendStoredActionResponse(res, raced);
    }
    return res.status(409).json({ ok: false, error: "Action is already in progress" });
  }

  let result;
  let status = "ok";

  try {
    switch (type) {
      case "MARK_PAID": {
        const id = String(action.instance_id || "");
        const paidDate = action.paid_date || todayDate();
        const error = validateDateString(paidDate, "paid_date");
        if (!id) throw new Error("instance_id is required");
        if (error) throw new Error(error);
        const instance = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
        if (!instance) throw new Error("Instance not found");
        const amountPaid = getAmountPaid(id);
        const amountDue = Number(instance.amount || 0);
        const remaining = Math.max(0, amountDue - amountPaid);
        let paymentId = null;
        if (remaining > 0) {
          paymentId = randomUUID();
          db.prepare(
            "INSERT INTO payment_events (id, instance_id, amount, paid_date, created_at) VALUES (?, ?, ?, ?, ?)"
          ).run(paymentId, id, remaining, paidDate, nowIso());
        }
        db.prepare(
          "UPDATE instances SET status = 'paid', paid_date = ?, updated_at = ? WHERE id = ?"
        ).run(paidDate, nowIso(), id);
        logInstanceEvent(id, "marked_done", { paid_date: paidDate, amount: amountDue, payment_id: paymentId });
        const row = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
        result = { ok: true, instance: attachPayments([row])[0] };
        break;
      }
      case "MARK_PENDING": {
        const id = String(action.instance_id || "");
        if (!id) throw new Error("instance_id is required");
        const before = db.prepare("SELECT status FROM instances WHERE id = ?").get(id);
        db.prepare("DELETE FROM payment_events WHERE instance_id = ?").run(id);
        db.prepare(
          "UPDATE instances SET status = 'pending', paid_date = NULL, updated_at = ? WHERE id = ?"
        ).run(nowIso(), id);
        const row = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
        if (!row) throw new Error("Instance not found");
        logInstanceEvent(id, "status_changed", { from: before?.status || "pending", to: "pending" });
        result = { ok: true, instance: attachPayments([row])[0] };
        break;
      }
      case "SKIP_INSTANCE": {
        const id = String(action.instance_id || "");
        if (!id) throw new Error("instance_id is required");
        const before = db.prepare("SELECT status FROM instances WHERE id = ?").get(id);
        db.prepare(
          "UPDATE instances SET status = 'skipped', paid_date = NULL, updated_at = ? WHERE id = ?"
        ).run(nowIso(), id);
        const row = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
        if (!row) throw new Error("Instance not found");
        logInstanceEvent(id, "skipped", { from: before?.status || "pending", to: "skipped" });
        result = { ok: true, instance: attachPayments([row])[0] };
        break;
      }
      case "ADD_PAYMENT": {
        const id = String(action.instance_id || "");
        if (!id) throw new Error("instance_id is required");
        const amount = Number(action.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error("Amount must be > 0");
        }
        const paidDate = action.paid_date || todayDate();
        const error = validateDateString(paidDate, "paid_date");
        if (error) throw new Error(error);
        const instance = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
        if (!instance) throw new Error("Instance not found");
        const paymentId = randomUUID();
        db.prepare(
          "INSERT INTO payment_events (id, instance_id, amount, paid_date, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run(paymentId, id, amount, paidDate, nowIso());
        logInstanceEvent(id, "log_update", { amount, date: paidDate, payment_id: paymentId });
        const row = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
        result = {
          ok: true,
          payment: { id: paymentId, instance_id: id, amount, paid_date: paidDate },
          instance: attachPayments([row])[0],
        };
        break;
      }
      case "UNDO_PAYMENT": {
        const paymentId = String(action.payment_id || "");
        if (!paymentId) throw new Error("payment_id is required");
        const payment = db
          .prepare("SELECT * FROM payment_events WHERE id = ?")
          .get(paymentId);
        if (!payment) throw new Error("Payment not found");
        db.prepare("DELETE FROM payment_events WHERE id = ?").run(paymentId);
        logInstanceEvent(payment.instance_id, "update_removed", {
          amount: Number(payment.amount || 0),
          date: payment.paid_date,
          payment_id: payment.id,
        });
        const row = db
          .prepare("SELECT * FROM instances WHERE id = ?")
          .get(payment.instance_id);
        result = {
          ok: true,
          instance_id: payment.instance_id,
          instance: row ? attachPayments([row])[0] : null,
        };
        break;
      }
      case "SET_CASH_START": {
        const year = Number(action.year);
        const month = Number(action.month);
        const cashStart = Number(action.cash_start);
        if (!Number.isInteger(year) || !Number.isInteger(month)) {
          throw new Error("year and month are required");
        }
        if (!Number.isFinite(cashStart) || cashStart < 0) {
          throw new Error("cash_start must be >= 0");
        }
        db.prepare(
          `INSERT INTO month_settings (year, month, cash_start, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(year, month) DO UPDATE SET cash_start = excluded.cash_start, updated_at = excluded.updated_at`
        ).run(year, month, cashStart, nowIso());
        result = { ok: true };
        break;
      }
      case "UPDATE_INSTANCE_FIELDS": {
        const id = String(action.instance_id || "");
        if (!id) throw new Error("instance_id is required");
        const before = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
        if (!before) throw new Error("Instance not found");
        const fields = [];
        const values = [];
        const changes = {};
        let noteChange = null;
        if (action.amount !== undefined) {
          const amount = Number(action.amount);
          if (!Number.isFinite(amount) || amount < 0) throw new Error("Amount must be >= 0");
          if (Number(before.amount || 0) !== amount) {
            changes.amount = { from: Number(before.amount || 0), to: amount };
          }
          fields.push("amount = ?");
          values.push(amount);
        }
        if (action.name_snapshot !== undefined || action.name !== undefined) {
          const nameValue = String(action.name_snapshot ?? action.name ?? "").trim();
          if (!nameValue) throw new Error("Name is required");
          if (String(before.name_snapshot || "") !== nameValue) {
            changes.name = { from: String(before.name_snapshot || ""), to: nameValue };
          }
          fields.push("name_snapshot = ?");
          values.push(nameValue);
        }
        if (action.category_snapshot !== undefined || action.category !== undefined) {
          const categoryValue = String(action.category_snapshot ?? action.category ?? "").trim();
          if (String(before.category_snapshot || "") !== categoryValue) {
            changes.category = { from: before.category_snapshot || "", to: categoryValue || "" };
          }
          fields.push("category_snapshot = ?");
          values.push(categoryValue || null);
        }
        if (action.due_date !== undefined) {
          const error = validateDateString(action.due_date, "due_date");
          if (error) throw new Error(error);
          if (String(before.due_date || "") !== action.due_date) {
            changes.due_date = { from: before.due_date || "", to: action.due_date };
          }
          fields.push("due_date = ?");
          values.push(action.due_date);
        }
        if (action.note !== undefined) {
          if (String(before.note || "") !== String(action.note || "")) {
            noteChange = { from: before.note || "", to: action.note || "" };
          }
          fields.push("note = ?");
          values.push(action.note || null);
        }
        if (fields.length === 0) throw new Error("No fields to update");
        fields.push("updated_at = ?");
        values.push(nowIso());
        values.push(id);
        db.prepare(`UPDATE instances SET ${fields.join(", ")} WHERE id = ?`).run(
          ...values
        );
        const row = db.prepare("SELECT * FROM instances WHERE id = ?").get(id);
        if (!row) throw new Error("Instance not found");
        if (noteChange) {
          logInstanceEvent(id, "note_updated", noteChange);
        }
        const changeKeys = Object.keys(changes);
        if (changeKeys.length > 0) {
          logInstanceEvent(id, "edited", { changes });
        }
        result = { ok: true, instance: normalizeInstance(row) };
        break;
      }
      case "CREATE_TEMPLATE": {
        const payload = validateTemplateInput(action);
        if (payload.error) throw new Error(payload.error);
        const stamp = nowIso();
        const id = randomUUID();
        db.prepare(
          `INSERT INTO templates (
            id, name, category, amount_default, due_day, autopay, essential, active, default_note,
            match_payee_key, match_amount_tolerance, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          payload.name,
          payload.category,
          payload.amount_default,
          payload.due_day,
          payload.autopay,
          payload.essential,
          payload.active,
          payload.default_note,
          payload.match_payee_key,
          payload.match_amount_tolerance,
          stamp,
          stamp
        );
        if (action.year && action.month) {
          ensureMonth(Number(action.year), Number(action.month));
        } else {
          const now = new Date();
          ensureMonth(now.getFullYear(), now.getMonth() + 1);
        }
        const row = db.prepare("SELECT * FROM templates WHERE id = ?").get(id);
        result = { ok: true, template: normalizeTemplate(row) };
        break;
      }
      case "UPDATE_TEMPLATE": {
        const id = String(action.template_id || action.id || "");
        if (!id) throw new Error("template_id is required");
        const payload = validateTemplateInput(action);
        if (payload.error) throw new Error(payload.error);
        const stamp = nowIso();
        const changes = db.prepare(
          `UPDATE templates
           SET name = ?, category = ?, amount_default = ?, due_day = ?, autopay = ?, essential = ?, active = ?,
               default_note = ?, match_payee_key = ?, match_amount_tolerance = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          payload.name,
          payload.category,
          payload.amount_default,
          payload.due_day,
          payload.autopay,
          payload.essential,
          payload.active,
          payload.default_note,
          payload.match_payee_key,
          payload.match_amount_tolerance,
          stamp,
          id
        );
        if (changes.changes === 0) throw new Error("Template not found");
        const row = db.prepare("SELECT * FROM templates WHERE id = ?").get(id);
        const now = new Date();
        const year = Number(action.year) || now.getFullYear();
        const month = Number(action.month) || now.getMonth() + 1;
        applyTemplateToMonth(row, year, month);
        result = { ok: true, template: normalizeTemplate(row) };
        break;
      }
      case "DELETE_TEMPLATE": {
        const id = String(action.template_id || action.id || "");
        if (!id) throw new Error("template_id is required");
        const now = new Date();
        const year = Number(action.year) || now.getFullYear();
        const month = Number(action.month) || now.getMonth() + 1;
        const exists = db.prepare("SELECT id FROM templates WHERE id = ?").get(id);
        if (!exists) throw new Error("Template not found");
        deleteTemplateFromMonth(id, year, month);
        result = { ok: true };
        break;
      }
      case "ARCHIVE_TEMPLATE": {
        const id = String(action.template_id || action.id || "");
        if (!id) throw new Error("template_id is required");
        const stamp = nowIso();
        const changes = db
          .prepare("UPDATE templates SET active = 0, updated_at = ? WHERE id = ?")
          .run(stamp, id);
        if (changes.changes === 0) throw new Error("Template not found");
        result = { ok: true };
        break;
      }
      case "CREATE_FUND": {
        const payload = validateSinkingFundInput(action);
        if (payload.error) throw new Error(payload.error);
        const stamp = nowIso();
        const id = randomUUID();
        db.prepare(
          `INSERT INTO sinking_funds (
            id, name, category, target_amount, due_date, cadence, months_per_cycle, essential, active, auto_contribute,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          payload.name,
          payload.category,
          payload.target_amount,
          payload.due_date,
          payload.cadence,
          payload.months_per_cycle,
          payload.essential,
          payload.active,
          payload.auto_contribute,
          stamp,
          stamp
        );
        const row = db.prepare("SELECT * FROM sinking_funds WHERE id = ?").get(id);
        result = { ok: true, fund: normalizeSinkingFund(row) };
        break;
      }
      case "UPDATE_FUND": {
        const id = String(action.fund_id || action.id || "");
        if (!id) throw new Error("fund_id is required");
        const payload = validateSinkingFundInput(action);
        if (payload.error) throw new Error(payload.error);
        const stamp = nowIso();
        const changes = db.prepare(
          `UPDATE sinking_funds
           SET name = ?, category = ?, target_amount = ?, due_date = ?, cadence = ?, months_per_cycle = ?, essential = ?,
               active = ?, auto_contribute = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          payload.name,
          payload.category,
          payload.target_amount,
          payload.due_date,
          payload.cadence,
          payload.months_per_cycle,
          payload.essential,
          payload.active,
          payload.auto_contribute,
          stamp,
          id
        );
        if (changes.changes === 0) throw new Error("Fund not found");
        const row = db.prepare("SELECT * FROM sinking_funds WHERE id = ?").get(id);
        result = { ok: true, fund: normalizeSinkingFund(row) };
        break;
      }
      case "ARCHIVE_FUND": {
        const id = String(action.fund_id || action.id || "");
        if (!id) throw new Error("fund_id is required");
        const stamp = nowIso();
        const changes = db
          .prepare("UPDATE sinking_funds SET active = 0, updated_at = ? WHERE id = ?")
          .run(stamp, id);
        if (changes.changes === 0) throw new Error("Fund not found");
        result = { ok: true };
        break;
      }
      case "DELETE_FUND": {
        const id = String(action.fund_id || action.id || "");
        if (!id) throw new Error("fund_id is required");
        const run = db.transaction(() => {
          db.prepare("DELETE FROM sinking_events WHERE fund_id = ?").run(id);
          db.prepare("DELETE FROM sinking_funds WHERE id = ?").run(id);
        });
        run();
        result = { ok: true };
        break;
      }
      case "ADD_SINKING_EVENT": {
        const fundId = String(action.fund_id || "");
        if (!fundId) throw new Error("fund_id is required");
        const fund = db.prepare("SELECT * FROM sinking_funds WHERE id = ?").get(fundId);
        if (!fund) throw new Error("Fund not found");
        const type = String(action.event_type || action.type || "").toUpperCase();
        if (!["CONTRIBUTION", "WITHDRAWAL", "ADJUSTMENT"].includes(type)) {
          throw new Error("Invalid event_type");
        }
        const amount = Number(action.amount);
        if (!Number.isFinite(amount) || amount === 0) {
          throw new Error("amount must be non-zero");
        }
        if ((type === "CONTRIBUTION" || type === "WITHDRAWAL") && amount < 0) {
          throw new Error("amount must be positive");
        }
        const eventDate = action.event_date || todayDate();
        const dateError = validateDateString(eventDate, "event_date");
        if (dateError) throw new Error(dateError);
        const eventId = randomUUID();
        db.prepare(
          `INSERT INTO sinking_events (id, fund_id, amount, type, event_date, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(eventId, fundId, amount, type, eventDate, action.note || null, nowIso());
        result = {
          ok: true,
          event: {
            id: eventId,
            fund_id: fundId,
            amount,
            type,
            event_date: eventDate,
            note: action.note || null,
          },
        };
        break;
      }
      case "MARK_FUND_PAID": {
        const fundId = String(action.fund_id || "");
        if (!fundId) throw new Error("fund_id is required");
        const fund = db.prepare("SELECT * FROM sinking_funds WHERE id = ?").get(fundId);
        if (!fund) throw new Error("Fund not found");
        const amount =
          action.amount !== undefined ? Number(action.amount) : Number(fund.target_amount || 0);
        if (!Number.isFinite(amount) || amount <= 0) {
          throw new Error("amount must be > 0");
        }
        const eventDate = action.event_date || todayDate();
        const dateError = validateDateString(eventDate, "event_date");
        if (dateError) throw new Error(dateError);
        const eventId = randomUUID();
        const run = db.transaction(() => {
          db.prepare(
            `INSERT INTO sinking_events (id, fund_id, amount, type, event_date, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(eventId, fundId, amount, "WITHDRAWAL", eventDate, "Bill paid", nowIso());

          const monthsPer = resolveMonthsPerCycle(fund.cadence, fund.months_per_cycle);
          const nextDue = addMonthsToDate(fund.due_date, monthsPer);
          db.prepare(
            "UPDATE sinking_funds SET due_date = ?, updated_at = ? WHERE id = ?"
          ).run(nextDue, nowIso(), fundId);
        });
        run();
        const updated = db.prepare("SELECT * FROM sinking_funds WHERE id = ?").get(fundId);
        result = {
          ok: true,
          event: { id: eventId, fund_id: fundId, amount, type: "WITHDRAWAL", event_date: eventDate },
          fund: normalizeSinkingFund(updated),
        };
        break;
      }
      case "GENERATE_MONTH": {
        const year = Number(action.year);
        const month = Number(action.month);
        if (!Number.isInteger(year) || !Number.isInteger(month)) {
          throw new Error("year and month are required");
        }
        ensureMonth(year, month);
        result = { ok: true };
        break;
      }
      default:
        throw new Error("Unknown action type");
    }
  } catch (err) {
    status = "error";
    result = { ok: false, error: err.message };
  }

  db.prepare(
    "UPDATE actions SET type = ?, payload = ?, status = ?, result = ? WHERE id = ?"
  ).run(type, JSON.stringify(action), status, JSON.stringify(result), actionId);

  if (result && typeof result === "object" && !Array.isArray(result)) {
    result.action_id = actionId;
  }
  if (status === "error") {
    return res.status(400).json(result);
  }
  return res.json(result);
});

app.post("/internal/advisor/query", async (req, res) => {
  const startedAt = Date.now();
  const task = String(req.body?.task || "").trim();
  const payload = req.body?.payload || {};
  if (!task) {
    recordLlmLatency(Date.now() - startedAt, false);
    return res.status(400).json({ ok: false, error: "task required" });
  }
  try {
    const providerState = await buildProviderStatus();
    let provider = normalizeProviderName(
      providerState.active_provider || process.env.LLM_PROVIDER || "qwen-oauth"
    );
    if (!validProviderName(provider)) provider = "qwen-oauth";
    let oauth = null;
    let providerCredentials = null;

    const oauthFresh = await getQwenOauthFresh();
    if (oauthFresh && provider === "qwen-oauth") {
      oauth = oauthFresh;
    }
    if (provider === "qwen-oauth" && !oauth) {
      const next = getLlmProviderState();
      next.providers["qwen-oauth"] = {
        ...(next.providers["qwen-oauth"] || {}),
        connected: false,
        last_error: "Qwen login required.",
      };
      setLlmProviderState(next);
      recordLlmLatency(Date.now() - startedAt, false);
      return res.status(503).json({ ok: false, error: "Agent not connected. Connect Mamdou in Setup." });
    }
    if (provider === "openai" || provider === "anthropic") {
      const credential = getProviderCredential(provider);
      if (!credential) {
        recordLlmLatency(Date.now() - startedAt, false);
        return res.status(503).json({
          ok: false,
          error: `${provider} key is not configured. Connect Mamdou in Setup.`,
        });
      }
      providerCredentials = {
        api_key: credential.api_key,
        model: credential.model || providerState.providers?.[provider]?.model || null,
        base_url: credential.base_url || null,
      };
    }
    const cacheProviderKey = `${provider}:${oauth ? "connected" : providerCredentials ? "configured" : "anon"}`;
    const cached = getCachedLlmResult(task, payload, cacheProviderKey);
    if (cached) {
      recordLlmLatency(Date.now() - startedAt, true);
      return res.json({
        ...cached,
        cached: true,
      });
    }

    const result = await runWithTimeout(
      advisor.query(task, payload, { oauth, provider, providerCredentials }),
      LLM_ROUTE_TIMEOUT_MS
    );
    if (!result.ok) {
      const next = getLlmProviderState();
      if (validProviderName(provider)) {
        next.providers[provider] = {
          ...(next.providers[provider] || {}),
          connected: false,
          last_error: String(result.error || "Provider query failed."),
        };
        setLlmProviderState(next);
      }
      recordLlmLatency(Date.now() - startedAt, false);
      return res.status(503).json(result);
    }
    {
      const next = getLlmProviderState();
      if (validProviderName(provider)) {
        next.active_provider = provider;
        next.providers[provider] = {
          ...(next.providers[provider] || {}),
          connected: true,
          connected_at: nowIso(),
          last_error: null,
        };
        setLlmProviderState(next);
      }
    }
    setCachedLlmResult(task, payload, cacheProviderKey, result);
    recordLlmLatency(Date.now() - startedAt, true);
    return res.json({
      ...result,
      cached: false,
    });
  } catch (err) {
    if (err && err.code === "LLM_TIMEOUT") {
      metrics.llm_timeouts += 1;
      recordLlmLatency(Date.now() - startedAt, false);
      return res.status(504).json({ ok: false, error: "Mamdou timed out. Try again." });
    }
    recordLlmLatency(Date.now() - startedAt, false);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/internal/agent/log", (req, res) => {
  const body = req.body || {};
  const id = randomUUID();
  const createdAt = nowIso();
  const kind = String(body.kind || "command").trim() || "command";
  const status = String(body.status || "ok").trim() || "ok";
  const userText = typeof body.user_text === "string" ? body.user_text.trim() : null;
  const summary = typeof body.summary === "string" ? body.summary.trim() : null;
  const payload = safeJsonStringify(body.payload);
  const result = safeJsonStringify(body.result);

  db.prepare(
    `INSERT INTO agent_command_log
      (id, created_at, user_text, kind, summary, payload, result, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, createdAt, userText, kind, summary, payload, result, status);

  res.json({ ok: true, id });
});

app.get("/internal/agent/log", (req, res) => {
  const limitRaw = Number(req.query.limit || 20);
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 20;
  const rows = db
    .prepare(
      "SELECT * FROM agent_command_log ORDER BY datetime(created_at) DESC LIMIT ?"
    )
    .all(limit);
  const items = rows.map((row) => ({
    id: row.id,
    created_at: row.created_at,
    user_text: row.user_text,
    kind: row.kind,
    summary: row.summary,
    status: row.status,
    payload: safeJsonParse(row.payload),
    result: safeJsonParse(row.result),
  }));
  res.json({ ok: true, items });
});

app.get("/internal/behavior/features", (req, res) => {
  const parsed = parseYearMonth(req);
  if (!parsed) return res.status(400).json({ error: "Invalid year/month" });
  const windowSize = Number(req.query.window || 3);
  const safeWindow = Number.isInteger(windowSize) && windowSize > 0 ? windowSize : 3;
  const features = computeBehaviorFeatures(parsed.year, parsed.month, safeWindow);
  res.json({
    app: "au-jour-le-jour",
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    period: `${parsed.year}-${ledger.pad2(parsed.month)}`,
    window_months: safeWindow,
    generated_at: nowIsoLocal(),
    features,
  });
});

app.get("/reset", (req, res) => {
  res.send(`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Reset Au Jour Le Jour</title>
      <style>
        body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: #f6f7f9; color: #0f172a; display: grid; place-items: center; min-height: 100vh; margin: 0; }
        .card { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 6px 18px rgba(15,23,42,0.08); max-width: 420px; text-align: center; }
        button { margin-top: 16px; padding: 10px 16px; border-radius: 8px; border: none; background: #0f172a; color: white; cursor: pointer; }
        .meta { color: #475569; font-size: 13px; margin-top: 8px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Reset local data</h1>
        <p>This clears local browser storage for the tracker UI.</p>
        <button id="reset-btn">Reset now</button>
        <div id="status" class="meta"></div>
      </div>
      <script>
        async function reset() {
          const status = document.getElementById('status');
          status.textContent = 'Clearing local data...';
          try { localStorage.clear(); } catch (e) {}
          try {
            if (window.indexedDB && indexedDB.databases) {
              const dbs = await indexedDB.databases();
              await Promise.all((dbs || []).map((db) => new Promise((resolve) => {
                if (!db || !db.name) return resolve();
                const req = indexedDB.deleteDatabase(db.name);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
              })));
            } else if (window.indexedDB) {
              indexedDB.deleteDatabase('ajl_pwa');
              indexedDB.deleteDatabase('ajl_web');
            }
          } catch (e) {}
          try {
            if ('caches' in window) {
              const keys = await caches.keys();
              await Promise.all(keys.map((k) => caches.delete(k)));
            }
          } catch (e) {}
          try {
            if ('serviceWorker' in navigator) {
              const regs = await navigator.serviceWorker.getRegistrations();
              await Promise.all(regs.map((r) => r.unregister()));
            }
          } catch (e) {}
          status.textContent = 'Done. Redirecting...';
          setTimeout(() => location.replace('/'), 300);
        }
        document.getElementById('reset-btn').addEventListener('click', reset);
      </script>
    </body>
  </html>`);
});

app.get("/safe", (req, res) => {
  res.send(`<!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Safe Mode</title>
    </head>
    <body>
      <script>
        location.replace('/?safe=1');
      </script>
    </body>
  </html>`);
});

app.get("/api/health", (req, res) => {
  const uptimeSec = Math.max(0, Math.round(process.uptime()));
  const startedAt = new Date(Date.now() - uptimeSec * 1000).toISOString();
  res.json({
    ok: true,
    app: "au-jour-le-jour",
    mode: "local",
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    pid: process.pid,
    uptime_sec: uptimeSec,
    started_at: startedAt,
  });
});

app.get("/api/metrics", (req, res) => {
  const uptimeSec = Math.max(0, Math.round(process.uptime()));
  res.json({
    ok: true,
    app: "au-jour-le-jour",
    mode: "local",
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    uptime_sec: uptimeSec,
    metrics: {
      ...metrics,
      llm_cache_entries: llmCache.size,
      avg_llm_latency_ms:
        metrics.avg_llm_latency_ms === null ? null : Number(metrics.avg_llm_latency_ms),
      last_llm_latency_ms:
        metrics.last_llm_latency_ms === null ? null : Number(metrics.last_llm_latency_ms),
    },
  });
});

app.post("/api/system/diagnostics/clear-llm-cache", (req, res) => {
  const cleared = clearLlmCache();
  res.json({
    ok: true,
    cleared,
    request_id: req.requestId || null,
    message: "Mamdou cache cleared.",
  });
});

app.get("/api/system/routes", (req, res) => {
  res.json({
    ok: true,
    routes: getRouteRegistry(),
  });
});

app.get("/api/system/janitor/status", (req, res) => {
  res.json({ ok: true, state: getShannonStatusPayload() });
});

app.get("/api/system/shannon/status", (req, res) => {
  res.json({ ok: true, state: getShannonStatusPayload() });
});

app.get("/api/system/janitor/report", (req, res) => {
  const report = buildJanitorCombinedReport(shannonState.profile || "full");
  if (!report) return res.status(404).json({ error: "No Janitor report found." });
  res.json({ ok: true, report });
});

app.get("/api/system/shannon/report", (req, res) => {
  const report = buildJanitorCombinedReport(shannonState.profile || "full");
  if (!report) return res.status(404).json({ error: "No Janitor report found." });
  res.json({ ok: true, report });
});

function runJanitorScript(scriptPath, runId, tag, envOverrides = null) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: __dirname,
      env: envOverrides ? { ...process.env, ...envOverrides } : { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    shannonState.pid = child.pid || null;
    appendShannonLog("stdout", `[run ${runId}] ${tag} started (pid ${shannonState.pid || "?"}).`);

    let stdoutBuffer = "";
    let stderrBuffer = "";
    const consumeChunk = (source, chunk) => {
      const text = String(chunk || "");
      if (source === "stderr") {
        stderrBuffer += text;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() || "";
        lines.forEach((line) => appendShannonLog("stderr", line));
        return;
      }
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      lines.forEach((line) => appendShannonLog("stdout", line));
    };

    if (child.stdout) child.stdout.on("data", (chunk) => consumeChunk("stdout", chunk));
    if (child.stderr) child.stderr.on("data", (chunk) => consumeChunk("stderr", chunk));

    child.on("error", (err) => {
      const message = String(err?.message || err || "Unknown process error");
      appendShannonLog("stderr", `[run ${runId}] ${tag} process error: ${message}`);
      resolve({ code: -1, error: message });
    });

    child.on("close", (code) => {
      if (stdoutBuffer) appendShannonLog("stdout", stdoutBuffer);
      if (stderrBuffer) appendShannonLog("stderr", stderrBuffer);
      const exitCode = Number.isInteger(code) ? code : -1;
      appendShannonLog(
        exitCode === 0 ? "stdout" : "stderr",
        `[run ${runId}] ${tag} finished (exit ${exitCode}).`
      );
      resolve({ code: exitCode, error: null });
    });
  });
}

function startJanitorRun(profile, runtimeBaseUrl = "", runtimeRequired = false) {
  const normalizedProfile = profile === "adversarial"
    ? "adversarial"
    : profile === "llm-runtime"
      ? "llm-runtime"
      : "full";
  const runtimeBase = String(runtimeBaseUrl || "").trim();
  const requireRuntime = runtimeRequired === true;
  const runId = randomUUID();
  [
    janitorFunctionalReportPath,
    janitorAdversarialReportPath,
    janitorPropertyReportPath,
    janitorHygieneReportPath,
    janitorLlmReportPath,
    janitorLlmRuntimeReportPath,
  ].forEach((filePath) => {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      // ignore cleanup errors
    }
  });
  shannonState.running = true;
  shannonState.run_id = runId;
  shannonState.started_at = new Date().toISOString();
  shannonState.finished_at = null;
  shannonState.exit_code = null;
  shannonState.pid = null;
  shannonState.error = null;
  shannonState.report = null;
  shannonState.logs = [];
  shannonState.profile = normalizedProfile;
  shannonState.runtime_base = runtimeBase;
  shannonState.runtime_required = requireRuntime;
  shannonState.phase =
    normalizedProfile === "adversarial"
      ? "adversarial"
      : normalizedProfile === "llm-runtime"
        ? "llm-runtime"
        : "functional";
  appendShannonLog("stdout", `[run ${runId}] Janitor ${normalizedProfile} run started.`);

  void (async () => {
    let exitCode = 0;
    try {
      if (normalizedProfile === "full") {
        const functional = await runJanitorScript(
          janitorFunctionalScriptPath,
          runId,
          "functional"
        );
        if (functional.code !== 0) {
          throw new Error(`Functional Janitor failed (exit ${functional.code})`);
        }
      }

      shannonState.phase = "adversarial";
      if (normalizedProfile !== "llm-runtime") {
        const adversarial = await runJanitorScript(
          janitorAdversarialScriptPath,
          runId,
          "adversarial"
        );
        if (adversarial.code !== 0) {
          throw new Error(`Adversarial Janitor failed (exit ${adversarial.code})`);
        }
      }

      if (normalizedProfile === "full") {
        shannonState.phase = "property";
        const property = await runJanitorScript(janitorPropertyScriptPath, runId, "property");
        if (property.code !== 0) {
          throw new Error(`Property Janitor failed (exit ${property.code})`);
        }

        shannonState.phase = "hygiene";
        const hygiene = await runJanitorScript(janitorHygieneScriptPath, runId, "hygiene");
        if (hygiene.code !== 0) {
          throw new Error(`Hygiene Janitor failed (exit ${hygiene.code})`);
        }

        shannonState.phase = "llm";
        const llm = await runJanitorScript(janitorLlmScriptPath, runId, "llm");
        if (llm.code !== 0) {
          throw new Error(`LLM Janitor failed (exit ${llm.code})`);
        }

        shannonState.phase = "llm-runtime";
        const llmRuntime = await runJanitorScript(
          janitorLlmRuntimeScriptPath,
          runId,
          "llm-runtime",
          runtimeBase
            ? {
                AJL_JANITOR_TARGET_BASE: runtimeBase,
                AJL_JANITOR_RUNTIME_REQUIRED: requireRuntime ? "1" : "0",
              }
            : {
                AJL_JANITOR_RUNTIME_REQUIRED: requireRuntime ? "1" : "0",
              }
        );
        if (llmRuntime.code !== 0) {
          throw new Error(`LLM runtime Janitor failed (exit ${llmRuntime.code})`);
        }
      } else if (normalizedProfile === "llm-runtime") {
        shannonState.phase = "llm-runtime";
        const llmRuntime = await runJanitorScript(
          janitorLlmRuntimeScriptPath,
          runId,
          "llm-runtime",
          runtimeBase
            ? {
                AJL_JANITOR_TARGET_BASE: runtimeBase,
                AJL_JANITOR_RUNTIME_REQUIRED: requireRuntime ? "1" : "0",
              }
            : {
                AJL_JANITOR_RUNTIME_REQUIRED: requireRuntime ? "1" : "0",
              }
        );
        if (llmRuntime.code !== 0) {
          throw new Error(`LLM runtime Janitor failed (exit ${llmRuntime.code})`);
        }
      }

      appendShannonLog("stdout", `[run ${runId}] Janitor run completed successfully.`);
    } catch (err) {
      exitCode = 1;
      shannonState.error = String(err?.message || err || "Unknown Janitor failure");
      appendShannonLog("stderr", `[run ${runId}] ${shannonState.error}`);
    } finally {
      shannonState.running = false;
      shannonState.phase = null;
      shannonState.finished_at = new Date().toISOString();
      shannonState.exit_code = exitCode;
      shannonState.pid = null;
      shannonState.report = buildJanitorCombinedReport(normalizedProfile);
    }
  })();
}

function handleJanitorRunRequest(req, res) {
  const profileRaw = String(req.body?.profile || "").trim().toLowerCase();
  const runtimeRequired =
    req.body?.runtime_required === true ||
    String(req.body?.runtime_required || "").trim() === "1";
  const profile = profileRaw === "adversarial"
    ? "adversarial"
    : profileRaw === "llm-runtime"
      ? "llm-runtime"
      : "full";
  if (profile !== "llm-runtime" && !fs.existsSync(janitorAdversarialScriptPath)) {
    return res.status(500).json({ error: "Janitor adversarial script missing." });
  }
  if (profile === "full") {
    if (!fs.existsSync(janitorFunctionalScriptPath)) {
      return res.status(500).json({ error: "Janitor functional script missing." });
    }
    if (!fs.existsSync(janitorPropertyScriptPath)) {
      return res.status(500).json({ error: "Janitor property script missing." });
    }
    if (!fs.existsSync(janitorHygieneScriptPath)) {
      return res.status(500).json({ error: "Janitor hygiene script missing." });
    }
    if (!fs.existsSync(janitorLlmScriptPath)) {
      return res.status(500).json({ error: "Janitor LLM script missing." });
    }
    if (!fs.existsSync(janitorLlmRuntimeScriptPath)) {
      return res.status(500).json({ error: "Janitor LLM runtime script missing." });
    }
  }
  if (profile === "llm-runtime" && !fs.existsSync(janitorLlmRuntimeScriptPath)) {
    return res.status(500).json({ error: "Janitor LLM runtime script missing." });
  }
  if (shannonState.running) {
    return res.status(409).json({
      error: "Janitor is already running.",
      state: getShannonStatusPayload(),
    });
  }
  const runtimeBaseResolved = resolveJanitorRuntimeBase(
    req,
    req.body?.runtime_base || `http://127.0.0.1:${PORT}`
  );
  if (!runtimeBaseResolved.ok) {
    return res.status(400).json({ error: runtimeBaseResolved.error });
  }
  startJanitorRun(profile, runtimeBaseResolved.value, runtimeRequired);
  return res.json({ ok: true, started: true, state: getShannonStatusPayload() });
}

app.post("/api/system/janitor/run", (req, res) => handleJanitorRunRequest(req, res));

app.post("/api/system/shannon/run", (req, res) => {
  req.body = { ...(req.body || {}), profile: req.body?.profile || "full" };
  return handleJanitorRunRequest(req, res);
});

app.get("/api/system/diagnostics", async (req, res) => {
  expireStaleShares();
  const oauth = await getQwenOauthFresh();
  const oauthConnected = !!(oauth && !qwenOauth.isTokenExpired(oauth));
  const providerState = await buildProviderStatus();
  const activeProvider = normalizeProviderName(providerState.active_provider || "qwen-oauth");
  const activeProviderRow = providerState.providers?.[activeProvider] || {};
  const janitorReport = shannonState.report || buildJanitorCombinedReport(shannonState.profile || "full");
  const activeShare = db
    .prepare(
      "SELECT token, mode, owner_label, expires_at, last_published_at, updated_at FROM shares WHERE is_active = 1 ORDER BY datetime(updated_at) DESC LIMIT 1"
    )
    .get();
  const backupCount = fs
    .readdirSync(backupDir)
    .filter((name) => /^au_jour_le_jour_\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).length;

  res.json({
    ok: true,
    request_id: req.requestId || null,
    app: "au-jour-le-jour",
    mode: "local",
    app_version: APP_VERSION,
    schema_version: SCHEMA_VERSION,
    runtime: {
      pid: process.pid,
      uptime_sec: Math.max(0, Math.round(process.uptime())),
      node: process.version,
      host: HOST,
      port: PORT,
    },
    limits: {
      mutation_rate_per_min: MUTATION_RATE_PER_MIN,
      mutation_rate_window_ms: MUTATION_RATE_WINDOW_MS,
      share_lookup_rate_limit: SHARE_LOOKUP_RATE_LIMIT,
      share_lookup_ip_rate_limit: SHARE_LOOKUP_IP_RATE_LIMIT,
      share_lookup_window_ms: SHARE_LOOKUP_WINDOW_MS,
      llm_cache_ttl_ms: LLM_CACHE_TTL_MS,
      llm_route_timeout_ms: LLM_ROUTE_TIMEOUT_MS,
      request_timeout_ms: REQUEST_TIMEOUT_MS,
      json_body_limit: JSON_BODY_LIMIT,
      trust_proxy_headers: TRUST_PROXY_HEADERS,
      backup_retention_days: BACKUP_RETENTION_DAYS,
      local_api_key_enabled: LOCAL_API_KEY.length > 0,
    },
    llm: {
      provider: activeProvider,
      provider_label: providerDisplayName(activeProvider),
      connected:
        activeProvider === "qwen-oauth"
          ? oauthConnected
          : !!activeProviderRow.connected,
      providers: providerState.providers,
      token_expires_at: oauth?.expires_at || null,
      cache_entries: llmCache.size,
      metrics: {
        requests: metrics.llm_requests,
        errors: metrics.llm_errors,
        cache_hits: metrics.llm_cache_hits,
        timeouts: metrics.llm_timeouts,
        avg_latency_ms: metrics.avg_llm_latency_ms,
        last_latency_ms: metrics.last_llm_latency_ms,
      },
    },
    share: {
      relay_base_url: SHARE_RELAY_BASE_URL || null,
      viewer_base_url: getViewerBaseUrl(req),
      active: activeShare
        ? {
            token_preview: `${String(activeShare.token).slice(0, 8)}…`,
            mode: activeShare.mode,
            owner_label: activeShare.owner_label || null,
            expires_at: activeShare.expires_at || null,
            last_published_at: activeShare.last_published_at || null,
            updated_at: activeShare.updated_at,
          }
        : null,
    },
    janitor: {
      running: !!shannonState.running,
      run_id: shannonState.run_id || null,
      profile: shannonState.profile || "full",
      phase: shannonState.phase || null,
      runtime_base: shannonState.runtime_base || null,
      runtime_required: !!shannonState.runtime_required,
      started_at: shannonState.started_at || null,
      finished_at: shannonState.finished_at || null,
      exit_code: shannonState.exit_code,
      log_lines: shannonState.logs.length,
      report_generated_at: janitorReport?.generated_at || null,
    },
    storage: {
      db_file: path.basename(dbFile),
      backup_files: backupCount,
    },
  });
});

app.use((err, req, res, next) => {
  if (!err) return next();
  if (res.headersSent) return next(err);
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request payload too large.",
      },
      request_id: req?.requestId || null,
    });
  }
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      error: {
        code: "INVALID_JSON",
        message: "Invalid JSON body.",
      },
      request_id: req?.requestId || null,
    });
  }
  return res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error.",
    },
    request_id: req?.requestId || null,
  });
});

if (require.main === module) {
  if (!disableLock) {
    ensureSingleInstance();
  }
  ensureDailyBackup();
  const backupTimer = setInterval(ensureDailyBackup, 6 * 60 * 60 * 1000);
  backupTimer.unref();
  const oauthPruneTimer = setInterval(pruneOauthDeviceSessions, 6 * 60 * 60 * 1000);
  oauthPruneTimer.unref();
  app.listen(PORT, HOST, () => {
    console.log(`Au Jour Le Jour running on http://${HOST}:${PORT}`);
    if (PUBLIC_BASE_URL) {
      console.log(`Public URL: ${PUBLIC_BASE_URL}`);
    }
  });
}

module.exports = {
  app,
  db,
  getRouteRegistry,
  setRouteSecurityMeta,
  close: () => {
    try {
      db.close();
    } catch (err) {
      // ignore
    }
  },
};
