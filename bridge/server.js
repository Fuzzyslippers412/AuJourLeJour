const path = require("path");
const fs = require("fs");
const express = require("express");
const Database = require("better-sqlite3");
const cookie = require("cookie");
const { randomUUID } = require("crypto");
const advisor = require("./advisor");
const qwenOauth = require("./qwen_oauth");

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "bridge.sqlite");
const COOKIE_NAME = process.env.SESSION_COOKIE || "ajl_session";
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "false";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://aujourlejour.xyz,https://www.aujourlejour.xyz")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

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
`);

db.pragma("journal_mode = WAL");

const app = express();
app.use(express.json({ limit: "1mb" }));

function nowIso() {
  return new Date().toISOString();
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
}

app.use((req, res, next) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function getSessionId(req, res) {
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

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
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
  const sessionId = getSessionId(req, res);
  const task = String(req.body?.task || "").trim();
  const payload = req.body?.payload || {};
  if (!task) return res.status(400).json({ ok: false, error: "task required" });

  const oauth = await getOauthFresh(sessionId);
  if (!oauth) {
    return res.status(503).json({ ok: false, error: "Agent not connected" });
  }

  try {
    const result = await advisor.query(task, payload, { oauth, provider: "qwen-oauth" });
    if (!result.ok) return res.status(503).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`AJL Agent Bridge running on http://${HOST}:${PORT}`);
});
