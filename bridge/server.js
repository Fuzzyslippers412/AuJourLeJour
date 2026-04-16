const path = require("path");
const fs = require("fs");
const express = require("express");
const Database = require("better-sqlite3");
const QRCode = require("qrcode");
const cookie = require("cookie");
const { randomUUID, createHash } = require("crypto");
const advisor = require("./advisor");
const qwenOauth = require("./qwen_oauth");
const householdRuntime = require("../modules/household_runtime");

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "bridge.sqlite");
const COOKIE_NAME = process.env.SESSION_COOKIE || "ajl_session";
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "false";
const SHARE_VIEWER_BASE_URL = String(
  process.env.SHARE_VIEWER_BASE_URL || "https://aujourlejour.xyz"
)
  .trim()
  .replace(/\/+$/, "");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://aujourlejour.xyz,https://www.aujourlejour.xyz")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const BRIDGE_LLM_TIMEOUT_MS = Math.max(3000, Number(process.env.BRIDGE_LLM_TIMEOUT_MS || 22000));

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    session_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_type TEXT,
    resource_url TEXT,
    expiry_date INTEGER,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_device_sessions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
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

  CREATE INDEX IF NOT EXISTS idx_device_session_session_id ON oauth_device_sessions (session_id);

  CREATE TABLE IF NOT EXISTS shares (
    token TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('live','snapshot')),
    is_active INTEGER NOT NULL DEFAULT 1,
    payload TEXT,
    payload_version TEXT,
    owner_label TEXT,
    expires_at TEXT,
    last_published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_shares_owner_key ON shares (owner_key);
  CREATE INDEX IF NOT EXISTS idx_shares_updated_at ON shares (updated_at);

  CREATE TABLE IF NOT EXISTS households (
    id TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    name TEXT NOT NULL,
    owner_label TEXT,
    base_payload TEXT,
    payload_version TEXT,
    sync_mode TEXT NOT NULL DEFAULT 'live',
    invite_token TEXT,
    invite_expires_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_published_at TEXT
  );

  CREATE TABLE IF NOT EXISTS household_members (
    token TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT
  );

  CREATE TABLE IF NOT EXISTS household_events (
    id TEXT PRIMARY KEY,
    household_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    member_token TEXT NOT NULL,
    member_name TEXT NOT NULL,
    type TEXT NOT NULL,
    amount REAL,
    note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_household_owner_key ON households (owner_key);
  CREATE INDEX IF NOT EXISTS idx_household_invite ON households (invite_token);
  CREATE INDEX IF NOT EXISTS idx_household_member_household ON household_members (household_id);
  CREATE INDEX IF NOT EXISTS idx_household_events_household ON household_events (household_id);
  CREATE INDEX IF NOT EXISTS idx_household_events_item ON household_events (item_id);
`);

db.pragma("journal_mode = WAL");

const app = express();
app.use(express.json({ limit: "1mb" }));

const metrics = {
  started_at: nowIsoLocal(),
  requests_total: 0,
  request_errors: 0,
  share_lookups: 0,
  share_lookups_304: 0,
  share_lookup_limited: 0,
  llm_requests: 0,
  llm_errors: 0,
  llm_timeouts: 0,
  last_llm_latency_ms: null,
  avg_llm_latency_ms: null,
};
let llmLatencySamples = 0;

app.use((req, res, next) => {
  const incoming = String(req.headers["x-request-id"] || "").trim();
  const requestId = incoming || randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
});

app.use((req, res, next) => {
  metrics.requests_total += 1;
  res.on("finish", () => {
    if (res.statusCode >= 500) metrics.request_errors += 1;
  });
  next();
});

function nowIso() {
  return new Date().toISOString();
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

async function runWithTimeout(promise, timeoutMs) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("Bridge LLM request timed out.");
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

function pruneOauthDeviceSessions() {
  const cutoffIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `DELETE FROM oauth_device_sessions
     WHERE status IN ('approved','expired','error','superseded')
       AND created_at < ?`
  ).run(cutoffIso);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const isLocalOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin) || isLocalOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-AJL-Session, X-AJL-Share-Owner, X-AJL-Household-Owner, X-AJL-Household-Member, X-Request-Id"
    );
    res.setHeader("Vary", "Origin");
  }
}

app.use((req, res, next) => {
  setCors(req, res);
  if (req.path.startsWith("/api/") || req.path.startsWith("/internal/")) {
    res.setHeader("Cache-Control", "no-store");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function getSessionId(req, res) {
  const headerSession = req.headers["x-ajl-session"];
  if (headerSession && typeof headerSession === "string" && headerSession.trim()) {
    const sessionId = headerSession.trim();
    db.prepare("INSERT OR IGNORE INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)")
      .run(sessionId, nowIso(), nowIso());
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(nowIso(), sessionId);
    return sessionId;
  }
  const cookies = cookie.parse(req.headers.cookie || "");
  let sessionId = cookies[COOKIE_NAME];
  if (!sessionId) {
    sessionId = randomUUID();
    const serialized = cookie.serialize(COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: "Lax",
      secure: COOKIE_SECURE,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    res.setHeader("Set-Cookie", serialized);
    db.prepare("INSERT OR IGNORE INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)")
      .run(sessionId, nowIso(), nowIso());
  } else {
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(nowIso(), sessionId);
  }
  return sessionId;
}

function getOauth(sessionId) {
  const row = db.prepare("SELECT * FROM oauth_tokens WHERE session_id = ?").get(sessionId);
  if (!row) return null;
  return {
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    token_type: row.token_type,
    resource_url: row.resource_url,
    expiry_date: row.expiry_date,
  };
}

function setOauth(sessionId, oauth) {
  db.prepare(
    `INSERT INTO oauth_tokens (session_id, access_token, refresh_token, token_type, resource_url, expiry_date, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       token_type = excluded.token_type, resource_url = excluded.resource_url, expiry_date = excluded.expiry_date, updated_at = excluded.updated_at`
  ).run(
    sessionId,
    oauth.access_token,
    oauth.refresh_token || null,
    oauth.token_type || null,
    oauth.resource_url || null,
    oauth.expiry_date || null,
    nowIso()
  );
}

async function getOauthFresh(sessionId) {
  const oauth = getOauth(sessionId);
  if (!oauth) return null;
  if (!qwenOauth.isTokenExpired(oauth)) return oauth;
  if (!oauth.refresh_token) return null;
  try {
    const tokenData = await qwenOauth.refreshAccessToken(oauth.refresh_token);
    const fresh = qwenOauth.buildOAuthSettings({
      ...tokenData,
      resource_url: tokenData.resource_url || oauth.resource_url,
    });
    setOauth(sessionId, fresh);
    return fresh;
  } catch (err) {
    return null;
  }
}

function nowIsoLocal() {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const mm = String(Math.abs(offset) % 60).padStart(2, "0");
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
  return `${local}${sign}${hh}:${mm}`;
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

function generateShareToken() {
  return require("crypto").randomBytes(24).toString("base64url");
}

function generateOwnerKey() {
  return require("crypto").randomBytes(32).toString("base64url");
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

function buildViewerShareUrl(token) {
  const cleanToken = String(token || "").trim();
  if (!cleanToken) return "";
  return `${SHARE_VIEWER_BASE_URL}/?share=${encodeURIComponent(cleanToken)}`;
}

function readOwnerKey(req) {
  const key = String(req.headers["x-ajl-share-owner"] || "").trim();
  if (!key) return null;
  if (!/^[A-Za-z0-9_-]{24,256}$/.test(key)) return null;
  return key;
}

function readHouseholdOwnerKey(req) {
  const key = String(req.headers["x-ajl-household-owner"] || "").trim();
  if (!householdRuntime.isValidHouseholdOwnerKey(key)) return null;
  return key;
}

function readHouseholdMemberToken(req) {
  const token = String(req.headers["x-ajl-household-member"] || "").trim();
  if (!householdRuntime.isValidHouseholdMemberToken(token)) return null;
  return token;
}

function expireStaleHouseholdInvites() {
  const now = nowIso();
  db.prepare(
    `UPDATE households
        SET invite_token = NULL,
            invite_expires_at = NULL,
            updated_at = ?
      WHERE invite_token IS NOT NULL
        AND invite_expires_at IS NOT NULL
        AND invite_expires_at <= ?`
  ).run(now, now);
}

function buildHouseholdInviteUrl(inviteToken) {
  return householdRuntime.buildHouseholdInviteUrl(SHARE_VIEWER_BASE_URL, inviteToken);
}

function getDefaultInviteExpiry() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

function getHouseholdRow(householdId) {
  return db.prepare("SELECT * FROM households WHERE id = ? AND is_active = 1").get(householdId);
}

function getHouseholdMembers(householdId) {
  return db
    .prepare(
      `SELECT *
         FROM household_members
        WHERE household_id = ?
          AND is_active = 1
        ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, lower(display_name), created_at`
    )
    .all(householdId);
}

function getHouseholdEvents(householdId) {
  return db
    .prepare(
      `SELECT *
         FROM household_events
        WHERE household_id = ?
        ORDER BY datetime(created_at) DESC`
    )
    .all(householdId);
}

function touchHouseholdMember(memberToken) {
  if (!householdRuntime.isValidHouseholdMemberToken(memberToken)) return;
  db.prepare(
    "UPDATE household_members SET last_seen_at = ?, updated_at = ? WHERE token = ?"
  ).run(nowIso(), nowIso(), memberToken);
}

function resolveHouseholdAccess(req, householdId) {
  const row = getHouseholdRow(householdId);
  if (!row) return { ok: false, status: 404, error: "Household not found." };

  const ownerKey = readHouseholdOwnerKey(req);
  if (ownerKey && ownerKey === row.owner_key) {
    return {
      ok: true,
      household: row,
      role: "owner",
      member: getHouseholdMembers(householdId).find((member) => member.role === "owner") || null,
    };
  }

  const memberToken = readHouseholdMemberToken(req);
  if (!memberToken) {
    return { ok: false, status: 401, error: "Household access requires a valid member token." };
  }
  const member = db
    .prepare(
      "SELECT * FROM household_members WHERE token = ? AND household_id = ? AND is_active = 1 LIMIT 1"
    )
    .get(memberToken, householdId);
  if (!member) {
    return { ok: false, status: 401, error: "Household member token is not valid." };
  }
  touchHouseholdMember(memberToken);
  return { ok: true, household: row, role: member.role, member };
}

function buildHouseholdResponse(row, access) {
  const payload = householdRuntime.safeJsonParse(row.base_payload) || {
    schema_version: "1",
    period: null,
    items: [],
  };
  const members = getHouseholdMembers(row.id);
  const events = getHouseholdEvents(row.id);
  const ledgerView = householdRuntime.aggregateHouseholdLedger(payload, members, events);
  return {
    household: {
      id: row.id,
      name: row.name,
      owner_label: row.owner_label || null,
      role: access.role,
      member_name: access.member?.display_name || null,
      sync_mode: row.sync_mode || "live",
      period: payload.period || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_published_at: row.last_published_at || null,
      invite: access.role === "owner" ? {
        token: row.invite_token || null,
        url: row.invite_token ? buildHouseholdInviteUrl(row.invite_token) : "",
        expires_at: row.invite_expires_at || null,
      } : null,
      summary: ledgerView.summary,
      members: ledgerView.members,
      items: ledgerView.items,
      activity: ledgerView.activity,
    },
  };
}

const shareLookup = new Map();

function pruneShareLookup(nowTs) {
  if (shareLookup.size < 2000) return;
  for (const [key, entry] of shareLookup.entries()) {
    if (!entry || typeof entry.ts !== "number" || nowTs - entry.ts > 5 * 60 * 1000) {
      shareLookup.delete(key);
    }
  }
}

function rateLimitShareLookup(req, res) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown");
  const nowTs = Date.now();
  pruneShareLookup(nowTs);
  const entry = shareLookup.get(ip) || { count: 0, ts: nowTs };
  if (nowTs - entry.ts > 60_000) {
    entry.count = 0;
    entry.ts = nowTs;
  }
  entry.count += 1;
  shareLookup.set(ip, entry);
  if (entry.count > 90) {
    metrics.share_lookup_limited += 1;
    res.status(429).json({ error: "Too many requests" });
    return false;
  }
  return true;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "ajl-share-relay",
    mode: "relay",
    app_version: "1.0",
    schema_version: "1",
    generated_at: nowIsoLocal(),
  });
});

app.get("/api/qr", async (req, res) => {
  const value = String(req.query?.value || "").trim();
  const size = Math.max(96, Math.min(320, Number(req.query?.size) || 176));
  if (!value) return res.status(400).json({ error: "QR value is required." });
  if (value.length > 4096) {
    return res.status(400).json({ error: "QR value is too long." });
  }
  try {
    const svg = await QRCode.toString(value, {
      type: "svg",
      width: size,
      margin: 1,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    });
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(svg);
  } catch (err) {
    res.status(500).json({ error: "Unable to generate QR code." });
  }
});

app.get("/api/metrics", (req, res) => {
  res.json({
    ok: true,
    app: "ajl-share-relay",
    mode: "relay",
    uptime_sec: Math.max(0, Math.round(process.uptime())),
    request_id: req.requestId || null,
    metrics: {
      ...metrics,
      avg_llm_latency_ms:
        metrics.avg_llm_latency_ms === null ? null : Number(metrics.avg_llm_latency_ms),
      last_llm_latency_ms:
        metrics.last_llm_latency_ms === null ? null : Number(metrics.last_llm_latency_ms),
    },
  });
});

app.get("/api/shares", (req, res) => {
  const ownerKey = readOwnerKey(req);
  if (!ownerKey) return res.status(401).json({ error: "Unauthorized" });
  expireStaleShares();
  const row = db
    .prepare("SELECT * FROM shares WHERE owner_key = ? AND is_active = 1 ORDER BY datetime(updated_at) DESC LIMIT 1")
    .get(ownerKey);
  if (!row) return res.json({ share: null });
  res.json({
    share: {
      token: row.token,
      mode: row.mode,
      is_active: !!row.is_active,
      owner_label: row.owner_label || null,
      expires_at: row.expires_at || null,
      last_published_at: row.last_published_at || null,
      shareUrl: buildViewerShareUrl(row.token),
      ownerKey,
    },
  });
});

app.post("/api/shares", (req, res) => {
  const mode = req.body?.mode === "snapshot" ? "snapshot" : "live";
  const ownerLabel = sanitizeOwnerLabel(req.body?.owner_label);
  const expires = parseShareExpiresAt(req.body?.expires_at);
  if (!expires.ok) return res.status(400).json({ error: expires.error });
  const ownerKey = readOwnerKey(req) || generateOwnerKey();
  const token = generateShareToken();
  const now = nowIso();
  db.prepare("UPDATE shares SET is_active = 0, updated_at = ? WHERE owner_key = ? AND is_active = 1")
    .run(now, ownerKey);
  db.prepare(
    `INSERT INTO shares (token, owner_key, mode, is_active, payload, payload_version, owner_label, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, NULL, NULL, ?, ?, ?, ?)`
  ).run(
    token,
    ownerKey,
    mode,
    ownerLabel,
    expires.value === undefined ? null : expires.value,
    now,
    now
  );
  res.json({
    shareUrl: buildViewerShareUrl(token),
    shareToken: token,
    mode,
    expires_at: expires.value === undefined ? null : expires.value,
    ownerKey,
  });
});

app.patch("/api/shares/:token", (req, res) => {
  const ownerKey = readOwnerKey(req);
  if (!ownerKey) return res.status(401).json({ error: "Unauthorized" });
  expireStaleShares();
  const token = String(req.params.token || "");
  if (!isValidShareToken(token)) return res.status(400).json({ error: "Invalid token" });
  const row = db.prepare("SELECT * FROM shares WHERE token = ?").get(token);
  if (!row) return res.status(404).json({ error: "Share not found" });
  if (row.owner_key !== ownerKey) return res.status(401).json({ error: "Unauthorized" });

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
  if (updates.length === 0) return res.json({ ok: true });

  updates.push("updated_at = ?");
  values.push(nowIso());
  values.push(token);
  db.prepare(`UPDATE shares SET ${updates.join(", ")} WHERE token = ?`).run(...values);
  res.json({ ok: true });
});

app.post("/api/shares/:token/regenerate", (req, res) => {
  const ownerKey = readOwnerKey(req);
  if (!ownerKey) return res.status(401).json({ error: "Unauthorized" });
  expireStaleShares();
  const token = String(req.params.token || "");
  if (!isValidShareToken(token)) return res.status(400).json({ error: "Invalid token" });
  const row = db.prepare("SELECT * FROM shares WHERE token = ?").get(token);
  if (!row) return res.status(404).json({ error: "Share not found" });
  if (row.owner_key !== ownerKey) return res.status(401).json({ error: "Unauthorized" });
  const newToken = generateShareToken();
  const now = nowIso();
  const nextExpiry = row.expires_at && !isExpiredIso(row.expires_at) ? row.expires_at : null;
  db.prepare("UPDATE shares SET is_active = 0, updated_at = ? WHERE token = ?").run(now, token);
  db.prepare(
    `INSERT INTO shares (token, owner_key, mode, is_active, payload, payload_version, owner_label, expires_at, last_published_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newToken,
    ownerKey,
    row.mode,
    row.payload,
    row.payload_version,
    row.owner_label,
    nextExpiry,
    row.last_published_at,
    now,
    now
  );
  res.json({
    shareUrl: buildViewerShareUrl(newToken),
    shareToken: newToken,
    expires_at: nextExpiry,
    ownerKey,
  });
});

app.post("/api/shares/:token/publish", (req, res) => {
  const ownerKey = readOwnerKey(req);
  if (!ownerKey) return res.status(401).json({ error: "Unauthorized" });
  expireStaleShares();
  const token = String(req.params.token || "");
  if (!isValidShareToken(token)) return res.status(400).json({ error: "Invalid token" });
  const row = db.prepare("SELECT * FROM shares WHERE token = ?").get(token);
  if (!row) return res.status(404).json({ error: "Share not found" });
  if (row.owner_key !== ownerKey) return res.status(401).json({ error: "Unauthorized" });
  if (isExpiredIso(row.expires_at)) {
    db.prepare("UPDATE shares SET is_active = 0, updated_at = ? WHERE token = ?").run(nowIso(), token);
    return res.status(410).json({ error: "This link has expired." });
  }
  const payload = req.body?.payload;
  const payloadCheck = validateSharePayload(payload);
  if (!payloadCheck.ok) return res.status(400).json({ error: payloadCheck.error });
  const payloadString = safeJsonStringify(payload);
  if (!payloadString) return res.status(400).json({ error: "Invalid payload" });
  if (Buffer.byteLength(payloadString, "utf8") > MAX_SHARE_PAYLOAD_BYTES) {
    return res.status(400).json({ error: "Payload too large" });
  }
  const version = req.body?.schema_version || payload.schema_version || null;
  const ownerLabel = sanitizeOwnerLabel(req.body?.owner_label) || row.owner_label || null;
  const now = nowIso();
  db.prepare(
    "UPDATE shares SET payload = ?, payload_version = ?, owner_label = ?, last_published_at = ?, updated_at = ? WHERE token = ?"
  ).run(payloadString, version, ownerLabel, now, now, token);
  res.json({ ok: true });
});

app.get("/api/shares/:token", (req, res) => {
  expireStaleShares();
  if (!rateLimitShareLookup(req, res)) return;
  metrics.share_lookups += 1;
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
    metrics.share_lookups_304 += 1;
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

app.post("/api/households", (req, res) => {
  expireStaleHouseholdInvites();
  const name = householdRuntime.sanitizeHouseholdName(req.body?.name || "Shared household");
  const ownerName =
    householdRuntime.sanitizeMemberName(req.body?.display_name || req.body?.member_name || req.body?.owner_name) ||
    "Owner";
  const ownerLabel = sanitizeOwnerLabel(req.body?.owner_label || ownerName);
  const payload = req.body?.payload;
  const payloadCheck = householdRuntime.validateHouseholdPayload(payload);
  if (!payloadCheck.ok) return res.status(400).json({ error: payloadCheck.error });
  const inviteExpiry = householdRuntime.parseInviteExpiresAt(req.body?.invite_expires_at);
  if (!inviteExpiry.ok) return res.status(400).json({ error: inviteExpiry.error });
  const now = nowIso();
  const householdId = householdRuntime.generateHouseholdId();
  const ownerKey = householdRuntime.generateHouseholdOwnerKey();
  const ownerMemberToken = householdRuntime.generateHouseholdMemberToken();
  const inviteToken = householdRuntime.generateHouseholdInviteToken();
  const payloadString = householdRuntime.safeJsonStringify(payload);
  db.prepare(
    `INSERT INTO households (
      id, owner_key, name, owner_label, base_payload, payload_version, sync_mode,
      invite_token, invite_expires_at, is_active, created_at, updated_at, last_published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    householdId,
    ownerKey,
    name || "Shared household",
    ownerLabel,
    payloadString,
    String(payload.schema_version || "1"),
    req.body?.sync_mode === "manual" ? "manual" : "live",
    inviteToken,
    inviteExpiry.value === undefined ? getDefaultInviteExpiry() : inviteExpiry.value,
    now,
    now,
    now
  );
  db.prepare(
    `INSERT INTO household_members (
      token, household_id, display_name, role, is_active, created_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, 'owner', 1, ?, ?, ?)`
  ).run(ownerMemberToken, householdId, ownerName, now, now, now);
  const access = {
    role: "owner",
    member: { token: ownerMemberToken, display_name: ownerName, role: "owner" },
  };
  res.json({
    ...buildHouseholdResponse(getHouseholdRow(householdId), access),
    session: {
      household_id: householdId,
      owner_key: ownerKey,
      member_token: ownerMemberToken,
      display_name: ownerName,
      role: "owner",
    },
  });
});

app.post("/api/households/join", (req, res) => {
  expireStaleHouseholdInvites();
  const inviteToken = householdRuntime.parseInviteToken(
    req.body?.invite_token || req.body?.invite || req.body?.invite_url || ""
  );
  if (!householdRuntime.isValidHouseholdInviteToken(inviteToken)) {
    return res.status(400).json({ error: "Invite link is not valid." });
  }
  const displayName = householdRuntime.sanitizeMemberName(req.body?.display_name || req.body?.member_name);
  if (!displayName) {
    return res.status(400).json({ error: "Enter a display name to join this household." });
  }
  const row = db
    .prepare("SELECT * FROM households WHERE invite_token = ? AND is_active = 1 LIMIT 1")
    .get(inviteToken);
  if (!row) return res.status(404).json({ error: "This invite is invalid or has been disabled." });
  if (row.invite_expires_at && row.invite_expires_at <= nowIso()) {
    return res.status(410).json({ error: "This invite has expired." });
  }
  const now = nowIso();
  const memberToken = householdRuntime.generateHouseholdMemberToken();
  db.prepare(
    `INSERT INTO household_members (
      token, household_id, display_name, role, is_active, created_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, 'member', 1, ?, ?, ?)`
  ).run(memberToken, row.id, displayName, now, now, now);
  const access = {
    role: "member",
    member: { token: memberToken, display_name: displayName, role: "member" },
  };
  res.json({
    ...buildHouseholdResponse(getHouseholdRow(row.id), access),
    session: {
      household_id: row.id,
      member_token: memberToken,
      display_name: displayName,
      role: "member",
    },
  });
});

app.post("/api/households/recover", (req, res) => {
  expireStaleHouseholdInvites();
  const recovery = householdRuntime.parseHouseholdRecoveryCode(
    req.body?.recovery_code || req.body?.recoveryCode || ""
  );
  const householdId = String(
    recovery.household_id || req.body?.household_id || req.body?.householdId || ""
  ).trim();
  const ownerKey = String(recovery.owner_key || req.body?.owner_key || req.body?.ownerKey || "").trim();
  if (!householdRuntime.isValidHouseholdId(householdId)) {
    return res.status(400).json({ error: "Household recovery code is not valid." });
  }
  if (!householdRuntime.isValidHouseholdOwnerKey(ownerKey)) {
    return res.status(400).json({ error: "Owner recovery key is not valid." });
  }
  const row = getHouseholdRow(householdId);
  if (!row) return res.status(404).json({ error: "Shared household not found." });
  if (row.owner_key !== ownerKey) {
    return res.status(401).json({ error: "Owner recovery key does not match this household." });
  }
  const existingOwner = db
    .prepare(
      "SELECT token, display_name FROM household_members WHERE household_id = ? AND role = 'owner' ORDER BY datetime(created_at) ASC LIMIT 1"
    )
    .get(householdId);
  const displayName =
    householdRuntime.sanitizeMemberName(req.body?.display_name || req.body?.member_name) ||
    existingOwner?.display_name ||
    "Owner";
  const now = nowIso();
  const ownerMemberToken = householdRuntime.generateHouseholdMemberToken();
  if (existingOwner?.token) {
    db.prepare(
      `UPDATE household_members
          SET token = ?, display_name = ?, is_active = 1, updated_at = ?, last_seen_at = ?
        WHERE token = ?`
    ).run(ownerMemberToken, displayName, now, now, existingOwner.token);
  } else {
    db.prepare(
      `INSERT INTO household_members (
        token, household_id, display_name, role, is_active, created_at, updated_at, last_seen_at
      ) VALUES (?, ?, ?, 'owner', 1, ?, ?, ?)`
    ).run(ownerMemberToken, householdId, displayName, now, now, now);
  }
  const access = {
    role: "owner",
    member: { token: ownerMemberToken, display_name: displayName, role: "owner" },
  };
  res.json({
    ...buildHouseholdResponse(getHouseholdRow(householdId), access),
    session: {
      household_id: householdId,
      owner_key: ownerKey,
      member_token: ownerMemberToken,
      display_name: displayName,
      role: "owner",
    },
  });
});

app.post("/api/households/:id/owner-key", (req, res) => {
  expireStaleHouseholdInvites();
  const householdId = String(req.params.id || "").trim();
  if (!householdRuntime.isValidHouseholdId(householdId)) {
    return res.status(400).json({ error: "Invalid household id." });
  }
  const access = resolveHouseholdAccess(req, householdId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  if (access.role !== "owner") {
    return res.status(403).json({ error: "Only the owner can rotate the recovery code." });
  }
  const nextOwnerKey = householdRuntime.generateHouseholdOwnerKey();
  db.prepare("UPDATE households SET owner_key = ?, updated_at = ? WHERE id = ?").run(
    nextOwnerKey,
    nowIso(),
    householdId
  );
  res.json({
    ...buildHouseholdResponse(getHouseholdRow(householdId), access),
    session: {
      household_id: householdId,
      owner_key: nextOwnerKey,
      member_token: access.member?.token || null,
      display_name: access.member?.display_name || "Owner",
      role: "owner",
    },
  });
});

app.get("/api/households/:id", (req, res) => {
  expireStaleHouseholdInvites();
  const householdId = String(req.params.id || "").trim();
  if (!householdRuntime.isValidHouseholdId(householdId)) {
    return res.status(400).json({ error: "Invalid household id." });
  }
  const access = resolveHouseholdAccess(req, householdId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  res.json(buildHouseholdResponse(access.household, access));
});

app.post("/api/households/:id/publish", (req, res) => {
  expireStaleHouseholdInvites();
  const householdId = String(req.params.id || "").trim();
  if (!householdRuntime.isValidHouseholdId(householdId)) {
    return res.status(400).json({ error: "Invalid household id." });
  }
  const access = resolveHouseholdAccess(req, householdId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  if (access.role !== "owner") return res.status(403).json({ error: "Only the owner can sync the household." });
  const payload = req.body?.payload;
  const payloadCheck = householdRuntime.validateHouseholdPayload(payload);
  if (!payloadCheck.ok) return res.status(400).json({ error: payloadCheck.error });
  const payloadString = householdRuntime.safeJsonStringify(payload);
  db.prepare(
    `UPDATE households
        SET name = ?, owner_label = ?, base_payload = ?, payload_version = ?, sync_mode = ?,
            last_published_at = ?, updated_at = ?
      WHERE id = ?`
  ).run(
    householdRuntime.sanitizeHouseholdName(req.body?.name || access.household.name) || access.household.name,
    sanitizeOwnerLabel(req.body?.owner_label || access.household.owner_label),
    payloadString,
    String(payload.schema_version || "1"),
    req.body?.sync_mode === "manual" ? "manual" : "live",
    nowIso(),
    nowIso(),
    householdId
  );
  res.json(buildHouseholdResponse(getHouseholdRow(householdId), access));
});

app.post("/api/households/:id/invite", (req, res) => {
  expireStaleHouseholdInvites();
  const householdId = String(req.params.id || "").trim();
  if (!householdRuntime.isValidHouseholdId(householdId)) {
    return res.status(400).json({ error: "Invalid household id." });
  }
  const access = resolveHouseholdAccess(req, householdId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  if (access.role !== "owner") return res.status(403).json({ error: "Only the owner can refresh invites." });
  const inviteExpiry = householdRuntime.parseInviteExpiresAt(req.body?.invite_expires_at);
  if (!inviteExpiry.ok) return res.status(400).json({ error: inviteExpiry.error });
  db.prepare(
    "UPDATE households SET invite_token = ?, invite_expires_at = ?, updated_at = ? WHERE id = ?"
  ).run(
    householdRuntime.generateHouseholdInviteToken(),
    inviteExpiry.value === undefined ? getDefaultInviteExpiry() : inviteExpiry.value,
    nowIso(),
    householdId
  );
  res.json(buildHouseholdResponse(getHouseholdRow(householdId), access));
});

app.delete("/api/households/:id/members/:memberToken", (req, res) => {
  expireStaleHouseholdInvites();
  const householdId = String(req.params.id || "").trim();
  const memberToken = String(req.params.memberToken || "").trim();
  if (!householdRuntime.isValidHouseholdId(householdId)) {
    return res.status(400).json({ error: "Invalid household id." });
  }
  if (!householdRuntime.isValidHouseholdMemberToken(memberToken)) {
    return res.status(400).json({ error: "Invalid household member token." });
  }
  const access = resolveHouseholdAccess(req, householdId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const target = db
    .prepare(
      "SELECT * FROM household_members WHERE token = ? AND household_id = ? AND is_active = 1 LIMIT 1"
    )
    .get(memberToken, householdId);
  if (!target) return res.status(404).json({ error: "Household member not found." });
  const isSelf = access.member?.token === memberToken;
  if (access.role !== "owner" && !isSelf) {
    return res.status(403).json({ error: "Only the owner can remove other household members." });
  }
  if (target.role === "owner") {
    return res.status(400).json({ error: "The owner device cannot be removed from the shared household." });
  }
  db.prepare("UPDATE household_members SET is_active = 0, updated_at = ? WHERE token = ?").run(
    nowIso(),
    memberToken
  );
  res.json({
    ...buildHouseholdResponse(getHouseholdRow(householdId), access),
    removed_member_token: memberToken,
    removed_member_name: target.display_name || null,
    removed_self: isSelf,
  });
});

app.post("/api/households/:id/events", (req, res) => {
  expireStaleHouseholdInvites();
  const householdId = String(req.params.id || "").trim();
  if (!householdRuntime.isValidHouseholdId(householdId)) {
    return res.status(400).json({ error: "Invalid household id." });
  }
  const access = resolveHouseholdAccess(req, householdId);
  if (!access.ok) return res.status(access.status).json({ error: access.error });
  const payload = householdRuntime.safeJsonParse(access.household.base_payload) || { items: [] };
  const itemId = String(req.body?.item_id || "").trim();
  if (!itemId) return res.status(400).json({ error: "item_id is required." });
  const item = Array.isArray(payload.items) ? payload.items.find((entry) => entry.id === itemId) : null;
  if (!item) return res.status(404).json({ error: "Household item not found." });
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Contribution amount must be greater than 0." });
  }
  db.prepare(
    `INSERT INTO household_events (
      id, household_id, item_id, member_token, member_name, type, amount, note, created_at
    ) VALUES (?, ?, ?, ?, ?, 'contribution', ?, ?, ?)`
  ).run(
    randomUUID(),
    householdId,
    itemId,
    access.member?.token || readHouseholdMemberToken(req) || householdRuntime.generateHouseholdMemberToken(),
    access.member?.display_name || "Member",
    Number(amount.toFixed(2)),
    householdRuntime.sanitizeNote(req.body?.note) || null,
    nowIso()
  );
  res.json(buildHouseholdResponse(getHouseholdRow(householdId), access));
});

app.get("/api/llm/qwen/oauth/status", async (req, res) => {
  const sessionId = getSessionId(req, res);
  const oauth = await getOauthFresh(sessionId);
  const connected = oauth && !qwenOauth.isTokenExpired(oauth);
  res.json({
    connected: !!connected,
    expires_at: oauth?.expiry_date || null,
    resource_url: oauth?.resource_url || null,
  });
});

app.get("/api/llm/qwen/oauth/last", (req, res) => {
  const sessionId = getSessionId(req, res);
  const row = db
    .prepare(
      `SELECT id, user_code, verification_uri, verification_uri_complete, interval_seconds, expires_at, status
       FROM oauth_device_sessions
       WHERE session_id = ? AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(sessionId);

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
  const sessionId = getSessionId(req, res);
  db.prepare(
    "UPDATE oauth_device_sessions SET status = 'superseded' WHERE session_id = ? AND status = 'pending'"
  ).run(sessionId);

  try {
    const payload = await qwenOauth.requestDeviceAuthorization();
    const expiresIn = Number(payload.expires_in || 600);
    const interval = Number(payload.interval || 5);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const deviceId = randomUUID();

    db.prepare(
      `INSERT INTO oauth_device_sessions (
        id, session_id, device_code, user_code, verification_uri, verification_uri_complete,
        code_verifier, interval_seconds, expires_at, status, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      deviceId,
      sessionId,
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
      session_id: deviceId,
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
  const sessionId = getSessionId(req, res);
  const deviceId = String(req.body?.session_id || "").trim();
  if (!deviceId) return res.status(400).json({ error: "session_id required" });

  const session = db
    .prepare("SELECT * FROM oauth_device_sessions WHERE id = ? AND session_id = ?")
    .get(deviceId, sessionId);
  if (!session) return res.status(404).json({ error: "OAuth session not found" });

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    db.prepare("UPDATE oauth_device_sessions SET status = 'expired' WHERE id = ?").run(deviceId);
    return res.json({ status: "expired", message: "Device code expired." });
  }

  try {
    const result = await qwenOauth.pollDeviceToken(session.device_code, session.code_verifier);
    if (result.status === "pending") {
      let interval = session.interval_seconds;
      if (result.slow_down) {
        interval = Math.min(interval + 5, 30);
        db.prepare("UPDATE oauth_device_sessions SET interval_seconds = ? WHERE id = ?").run(
          interval,
          deviceId
        );
      }
      return res.json({ status: "pending", interval_seconds: interval });
    }

    if (result.status === "error") {
      db.prepare("UPDATE oauth_device_sessions SET status = 'error', error = ? WHERE id = ?").run(
        result.error_description || result.error || "OAuth error",
        deviceId
      );
      return res.json({
        status: "error",
        message: result.error_description || result.error || "OAuth error",
      });
    }

    const tokenData = result.token || {};
    const oauthSettings = qwenOauth.buildOAuthSettings(tokenData);
    setOauth(sessionId, oauthSettings);

    db.prepare("UPDATE oauth_device_sessions SET status = 'approved', error = NULL WHERE id = ?")
      .run(deviceId);

    res.json({
      status: "success",
      expires_at: oauthSettings.expiry_date,
      resource_url: oauthSettings.resource_url,
    });
  } catch (err) {
    db.prepare("UPDATE oauth_device_sessions SET status = 'error', error = ? WHERE id = ?")
      .run(err.message || "OAuth error", deviceId);
    res.json({ status: "error", message: err.message || "OAuth error" });
  }
});

app.delete("/api/llm/qwen/oauth", (req, res) => {
  const sessionId = getSessionId(req, res);
  db.prepare("DELETE FROM oauth_tokens WHERE session_id = ?").run(sessionId);
  res.json({ ok: true });
});

app.post("/internal/advisor/query", async (req, res) => {
  const startedAt = Date.now();
  const sessionId = getSessionId(req, res);
  const task = String(req.body?.task || "").trim();
  const payload = req.body?.payload || {};
  if (!task) {
    recordLlmLatency(Date.now() - startedAt, false);
    return res.status(400).json({ ok: false, error: "task required" });
  }

  const oauth = await getOauthFresh(sessionId);
  if (!oauth) {
    recordLlmLatency(Date.now() - startedAt, false);
    return res.status(503).json({ ok: false, error: "Agent not connected" });
  }

  try {
    const result = await runWithTimeout(
      advisor.query(task, payload, { oauth, provider: "qwen-oauth" }),
      BRIDGE_LLM_TIMEOUT_MS
    );
    if (!result.ok) {
      recordLlmLatency(Date.now() - startedAt, false);
      return res.status(503).json(result);
    }
    recordLlmLatency(Date.now() - startedAt, true);
    return res.json(result);
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

pruneOauthDeviceSessions();
const pruneTimer = setInterval(pruneOauthDeviceSessions, 6 * 60 * 60 * 1000);
pruneTimer.unref();

app.listen(PORT, HOST, () => {
  console.log(`AJL Agent Bridge running on http://${HOST}:${PORT}`);
});
