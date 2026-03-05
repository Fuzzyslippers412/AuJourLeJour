#!/usr/bin/env node
/* Simple AJL CLI for local power users */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const argv = process.argv.slice(2);
const command = argv[0];

function argValue(flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  return argv[idx + 1] || null;
}

function usage() {
  console.log(`AJL CLI

Commands:
  health                Fetch local health (includes PID)
  doctor                Run local readiness checks (server, DB, Mamdou, share)
  lan                   Print LAN URLs for this server
  backup                 Copy SQLite DB to data/backups
  export-json            Export backup JSON via local server
  diagnostics            Fetch local diagnostics snapshot
  clear-llm-cache        Clear Mamdou response cache
  mamdou-status          Print Mamdou OAuth connection status
  mamdou-login           Start/poll Qwen OAuth from terminal
  mamdou-logout          Clear Mamdou OAuth session locally
  share-link             Print active share link (or create one)
  actions                List recent /api/v1/actions rows
  action                 Fetch one /api/v1/actions/:id row

Options:
  --port <port>          Local server port (default: 4567)
  --out <path>           Output file path
  --json                 Print full diagnostics JSON
  --limit <n>            Max rows for actions (default: 20)
  --status <value>       Action status filter (pending|ok|error)
  --id <actionId>        Action id for action command
  --timeout <seconds>    Timeout for mamdou-login polling (default: 180)
  --open                 Open OAuth URL in browser (mamdou-login)
  --create               Create new share if none exists (share-link)
  --disable              Disable current share link (share-link)
  --regenerate           Regenerate current share link (share-link)
  --mode <live|snapshot> Share mode when creating (default: live)
  --publish              Publish current month snapshot to active share (share-link)
  --year <yyyy>          Year for share publish snapshot (share-link)
  --month <1-12>         Month for share publish snapshot (share-link)
  --copy                 Copy share URL to clipboard when available
  --json                 Output JSON for health/doctor

Examples:
  node scripts/ajl_cli.js health --port 4567
  node scripts/ajl_cli.js doctor --port 4567
  node scripts/ajl_cli.js lan --port 4567
  node scripts/ajl_cli.js backup
  node scripts/ajl_cli.js export-json --port 6709 --out ./ajl_backup.json
  node scripts/ajl_cli.js diagnostics --port 4567
  node scripts/ajl_cli.js mamdou-status --port 4567
  node scripts/ajl_cli.js clear-llm-cache --port 4567
  node scripts/ajl_cli.js mamdou-login --port 4567 --open
  node scripts/ajl_cli.js mamdou-logout --port 4567
  node scripts/ajl_cli.js share-link --port 4567 --create --publish --copy --open
  node scripts/ajl_cli.js share-link --port 4567 --publish --year 2026 --month 3
  node scripts/ajl_cli.js actions --limit 20 --status ok
  node scripts/ajl_cli.js action --id <actionId>
`);
}

function getDbPath() {
  const base = path.resolve(__dirname, "..");
  const db = process.env.AJL_DB_PATH || path.join(base, "data", "au_jour_le_jour.sqlite");
  return db;
}

function ensureBackupDir() {
  const base = path.resolve(__dirname, "..");
  const dir = process.env.AJL_BACKUP_DIR || path.join(base, "data", "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cookieJar = "";

async function requestJson(port, method, urlPath, body) {
  const headers = {};
  if (cookieJar) headers.cookie = cookieJar;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    cookieJar = setCookie.split(";")[0];
  }
  let payload = null;
  const contentType = String(res.headers.get("content-type") || "");
  if (contentType.includes("application/json")) {
    payload = await res.json().catch(() => null);
  } else {
    payload = await res.text().catch(() => "");
  }
  return { res, payload };
}

async function requestJsonWithOwnerRetry(port, method, urlPath, body) {
  let first = await requestJson(port, method, urlPath, body);
  if (first.res.status !== 401) return first;
  // ensure owner cookie is issued, then retry once
  await requestJson(port, "GET", "/api/health");
  first = await requestJson(port, method, urlPath, body);
  return first;
}

function maybeOpenUrl(url) {
  if (!url) return;
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    if (platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch (err) {
    // ignore
  }
}

function maybeCopyText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  try {
    if (process.platform === "darwin") {
      const child = spawn("pbcopy");
      child.stdin.write(text);
      child.stdin.end();
      return true;
    }
  } catch (err) {
    return false;
  }
  return false;
}

function hostIsLocal(hostnameRaw) {
  const host = String(hostnameRaw || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
}

async function maybeResolveLanShareUrl(port, url, token) {
  const input = String(url || "").trim();
  if (!input) return input;
  try {
    const parsed = new URL(input);
    if (!hostIsLocal(parsed.hostname)) return input;
    const lanResult = await requestJson(port, "GET", "/api/lan");
    if (!lanResult.res.ok) return input;
    const urls = Array.isArray(lanResult.payload?.urls) ? lanResult.payload.urls : [];
    if (!urls[0]) return input;
    const base = String(urls[0]).replace(/\/+$/, "");
    const tok = String(token || "").trim();
    if (tok) {
      return `${base}/?share=${encodeURIComponent(tok)}`;
    }
    return base;
  } catch (err) {
    return input;
  }
}

function resolveDbFileExists(dbFileRaw) {
  const raw = String(dbFileRaw || "").trim();
  if (!raw) return false;
  const candidates = [];
  if (path.isAbsolute(raw)) {
    candidates.push(raw);
  } else {
    candidates.push(path.resolve(process.cwd(), raw));
    candidates.push(path.resolve(__dirname, "..", "data", raw));
    if (process.env.AJL_DATA_DIR) {
      candidates.push(path.resolve(process.env.AJL_DATA_DIR, raw));
    }
  }
  return candidates.some((candidate) => fs.existsSync(candidate));
}

async function doBackup() {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error("Database not found:", dbPath);
    process.exit(1);
  }
  const outFlag = argValue("--out");
  const backupDir = ensureBackupDir();
  const filename = outFlag || path.join(backupDir, `au_jour_le_jour_${timestamp()}.sqlite`);
  fs.copyFileSync(dbPath, filename);
  console.log("Backup written:", filename);
}

async function doHealth() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  const asJson = argv.includes("--json");
  const url = `http://127.0.0.1:${port}/api/health`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Health check failed (${res.status}). Is the server running on port ${port}?`);
      process.exit(1);
    }
    const data = await res.json();
    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(`ok: ${data.ok ? "yes" : "no"}`);
    console.log(`app: ${data.app}`);
    console.log(`mode: ${data.mode}`);
    console.log(`pid: ${data.pid}`);
    console.log(`uptime_sec: ${data.uptime_sec}`);
    console.log(`started_at: ${data.started_at || "n/a"}`);
  } catch (err) {
    console.error("Health check failed. Is the server running?", err.message);
    process.exit(1);
  }
}

async function doDoctor() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  const asJson = argv.includes("--json");
  const checks = [];
  const details = {};

  const pushCheck = (name, status, message, data = null) => {
    checks.push({ name, status, message });
    if (data && typeof data === "object") {
      details[name] = data;
    }
  };

  try {
    const health = await requestJson(port, "GET", "/api/health");
    if (!health.res.ok || !health.payload?.ok) {
      pushCheck("health", "fail", `Health endpoint failed (${health.res.status}).`);
    } else {
      pushCheck("health", "ok", `Server reachable (pid ${health.payload.pid}).`, health.payload);
    }
  } catch (err) {
    pushCheck("health", "fail", `Unable to reach server on port ${port}: ${err.message}`);
  }

  try {
    const diag = await requestJson(port, "GET", "/api/system/diagnostics");
    if (!diag.res.ok || !diag.payload?.ok) {
      pushCheck("diagnostics", "warn", `Diagnostics unavailable (${diag.res.status}).`);
    } else {
      const dbFile = String(diag.payload?.storage?.db_file || "").trim();
      const hasDbFile = resolveDbFileExists(dbFile);
      if (hasDbFile) {
        pushCheck("storage", "ok", `Database file present (${dbFile}).`, diag.payload.storage);
      } else {
        pushCheck("storage", "warn", "Database file path missing or not found.", diag.payload.storage);
      }
      const viewerBase = String(diag.payload?.share?.viewer_base_url || "");
      const localViewer = /:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)(?::|\/|$)/i.test(viewerBase);
      if (localViewer) {
        pushCheck("share_viewer", "warn", "Share viewer base is localhost (single-device only).", diag.payload.share);
      } else {
        pushCheck("share_viewer", "ok", "Share viewer base looks network-safe.", diag.payload.share);
      }
      const connected = !!diag.payload?.llm?.connected;
      if (connected) {
        pushCheck("mamdou", "ok", "Mamdou connected.", diag.payload.llm);
      } else {
        pushCheck("mamdou", "warn", "Mamdou not connected (run: npm run ajl -- mamdou-login --open).", diag.payload.llm);
      }
    }
  } catch (err) {
    pushCheck("diagnostics", "warn", `Diagnostics check failed: ${err.message}`);
  }

  try {
    const shares = await requestJsonWithOwnerRetry(port, "GET", "/api/shares");
    if (!shares.res.ok) {
      pushCheck("share_api", "warn", `Share status unavailable (${shares.res.status}).`);
    } else if (shares.payload?.share?.is_active) {
      pushCheck("share_api", "ok", "Active share link exists.", shares.payload.share);
    } else {
      pushCheck("share_api", "warn", "No active share link (run: npm run ajl -- share-link --create).");
    }
  } catch (err) {
    pushCheck("share_api", "warn", `Share check failed: ${err.message}`);
  }

  const failCount = checks.filter((item) => item.status === "fail").length;
  const warnCount = checks.filter((item) => item.status === "warn").length;
  const okCount = checks.filter((item) => item.status === "ok").length;
  const summary = {
    ok: failCount === 0,
    port,
    checks,
    counts: { ok: okCount, warn: warnCount, fail: failCount },
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    checks.forEach((item) => {
      const marker = item.status === "ok" ? "OK " : item.status === "warn" ? "WARN" : "FAIL";
      console.log(`[${marker}] ${item.name}: ${item.message}`);
    });
    console.log(`Summary: ${okCount} ok, ${warnCount} warn, ${failCount} fail.`);
  }

  if (failCount > 0) process.exit(1);
}

async function doLan() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  try {
    const result = await requestJson(port, "GET", "/api/lan");
    if (!result.res.ok || !result.payload?.ok) {
      console.error(`LAN check failed (${result.res.status}).`);
      process.exit(1);
    }
    const urls = Array.isArray(result.payload?.urls) ? result.payload.urls : [];
    if (urls.length === 0) {
      console.log("No LAN URLs found.");
      return;
    }
    urls.forEach((url) => console.log(url));
  } catch (err) {
    console.error("LAN check failed. Is the server running?", err.message);
    process.exit(1);
  }
}

async function doExportJson() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  const outFlag = argValue("--out") || `./au_jour_le_jour_backup_${timestamp()}.json`;
  const url = `http://127.0.0.1:${port}/api/export/backup.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Export failed (${res.status}). Is the server running on port ${port}?`);
      process.exit(1);
    }
    const data = await res.text();
    fs.writeFileSync(outFlag, data);
    console.log("Backup JSON written:", outFlag);
  } catch (err) {
    console.error("Export failed. Is the server running?", err.message);
    process.exit(1);
  }
}

function formatDiagnosticsSummary(diag) {
  const lines = [];
  lines.push(`App: ${diag?.app || "au-jour-le-jour"} ${diag?.app_version || ""}`.trim());
  lines.push(`Mode: ${diag?.mode || "local"} | PID: ${diag?.runtime?.pid || "?"}`);
  lines.push(`Uptime: ${diag?.runtime?.uptime_sec ?? "?"}s`);
  lines.push(`LLM connected: ${diag?.llm?.connected ? "yes" : "no"}`);
  lines.push(
    `LLM req/errors/cache/timeouts: ${diag?.llm?.metrics?.requests ?? 0}/${diag?.llm?.metrics?.errors ?? 0}/${diag?.llm?.metrics?.cache_hits ?? 0}/${diag?.llm?.metrics?.timeouts ?? 0}`
  );
  lines.push(`Share viewer base: ${diag?.share?.viewer_base_url || "n/a"}`);
  lines.push(`Active share: ${diag?.share?.active ? "yes" : "no"}`);
  lines.push(`Backups: ${diag?.storage?.backup_files ?? 0}`);
  return lines.join("\n");
}

async function doDiagnostics() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  const asJson = argv.includes("--json");
  const url = `http://127.0.0.1:${port}/api/system/diagnostics`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Diagnostics failed (${res.status}). Is the server running on port ${port}?`);
      process.exit(1);
    }
    const data = await res.json();
    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    console.log(formatDiagnosticsSummary(data));
  } catch (err) {
    console.error("Diagnostics failed. Is the server running?", err.message);
    process.exit(1);
  }
}

async function doClearLlmCache() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  const url = `http://127.0.0.1:${port}/api/system/diagnostics/clear-llm-cache`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!res.ok) {
      console.error(`Cache clear failed (${res.status}). Is the server running on port ${port}?`);
      process.exit(1);
    }
    const data = await res.json();
    console.log(`Mamdou cache cleared: ${Number(data?.cleared || 0)} entries.`);
  } catch (err) {
    console.error("Cache clear failed. Is the server running?", err.message);
    process.exit(1);
  }
}

async function doMamdouLogin() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  const timeoutRaw = Number(argValue("--timeout") || 180);
  const timeoutSec = Number.isFinite(timeoutRaw) ? Math.max(15, timeoutRaw) : 180;
  const autoOpen = argv.includes("--open");

  try {
    const statusResult = await requestJson(port, "GET", "/api/llm/qwen/oauth/status");
    if (!statusResult.res.ok) {
      console.error(`Unable to read OAuth status (${statusResult.res.status}).`);
      process.exit(1);
    }
    if (statusResult.payload?.connected) {
      console.log("Mamdou already connected.");
      console.log(`resource_url: ${statusResult.payload.resource_url || "n/a"}`);
      return;
    }

    const startResult = await requestJson(port, "POST", "/api/llm/qwen/oauth/start");
    if (!startResult.res.ok) {
      const msg = startResult.payload?.error || `OAuth start failed (${startResult.res.status}).`;
      console.error(msg);
      process.exit(1);
    }
    const sessionId = String(startResult.payload?.session_id || "");
    const authUrl = String(startResult.payload?.verification_uri_complete || startResult.payload?.verification_uri || "");
    const userCode = String(startResult.payload?.user_code || "");
    if (!sessionId || !authUrl) {
      console.error("OAuth start response missing required fields.");
      process.exit(1);
    }

    console.log(`session_id: ${sessionId}`);
    if (userCode) console.log(`user_code: ${userCode}`);
    console.log(`authorize_url: ${authUrl}`);
    console.log(`timeout_sec: ${timeoutSec}`);
    if (autoOpen) {
      maybeOpenUrl(authUrl);
      console.log("Opened browser for authorization.");
    }

    const deadline = Date.now() + timeoutSec * 1000;
    let intervalSec = Number(startResult.payload?.interval_seconds || 5);

    while (Date.now() < deadline) {
      await sleep(Math.max(2, intervalSec) * 1000);
      const pollResult = await requestJson(port, "POST", "/api/llm/qwen/oauth/poll", {
        session_id: sessionId,
      });
      if (!pollResult.res.ok) {
        const message = pollResult.payload?.error || `Poll failed (${pollResult.res.status}).`;
        console.error(message);
        process.exit(1);
      }
      const status = String(pollResult.payload?.status || "");
      if (status === "pending") {
        intervalSec = Number(pollResult.payload?.interval_seconds || intervalSec || 5);
        continue;
      }
      if (status === "success") {
        console.log("Mamdou connected.");
        const finalStatus = await requestJson(port, "GET", "/api/llm/qwen/oauth/status");
        if (finalStatus.res.ok) {
          console.log(`expires_at: ${finalStatus.payload?.expires_at || "n/a"}`);
          console.log(`resource_url: ${finalStatus.payload?.resource_url || "n/a"}`);
        }
        return;
      }
      if (status === "expired") {
        console.error("OAuth code expired. Run mamdou-login again.");
        process.exit(1);
      }
      const message = pollResult.payload?.message || "OAuth error.";
      console.error(message);
      process.exit(1);
    }

    console.error("Timed out waiting for authorization.");
    console.error(`Re-run command or continue polling manually with session_id: ${sessionId}`);
    process.exit(1);
  } catch (err) {
    console.error("Mamdou login failed. Is the server running?", err.message);
    process.exit(1);
  }
}

async function doMamdouStatus() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  const asJson = argv.includes("--json");
  try {
    const result = await requestJson(port, "GET", "/api/llm/qwen/oauth/status");
    if (!result.res.ok) {
      console.error(`Unable to read Mamdou status (${result.res.status}).`);
      process.exit(1);
    }
    if (asJson) {
      console.log(JSON.stringify(result.payload || {}, null, 2));
      return;
    }
    console.log(`connected: ${result.payload?.connected ? "yes" : "no"}`);
    console.log(`expires_at: ${result.payload?.expires_at || "n/a"}`);
    console.log(`resource_url: ${result.payload?.resource_url || "n/a"}`);
  } catch (err) {
    console.error("Mamdou status failed. Is the server running?", err.message);
    process.exit(1);
  }
}

async function doMamdouLogout() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  try {
    const result = await requestJson(port, "DELETE", "/api/llm/qwen/oauth");
    if (!result.res.ok) {
      console.error(`Mamdou logout failed (${result.res.status}).`);
      process.exit(1);
    }
    console.log("Mamdou session cleared.");
  } catch (err) {
    console.error("Mamdou logout failed. Is the server running?", err.message);
    process.exit(1);
  }
}

async function doShareLink() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  const create = argv.includes("--create");
  const disable = argv.includes("--disable");
  const regenerate = argv.includes("--regenerate");
  const publish = argv.includes("--publish");
  const copy = argv.includes("--copy");
  const autoOpen = argv.includes("--open");
  const asJson = argv.includes("--json");
  const modeRaw = String(argValue("--mode") || "live").toLowerCase();
  const mode = modeRaw === "snapshot" ? "snapshot" : "live";
  const yearRaw = argValue("--year");
  const monthRaw = argValue("--month");
  const hasYear = yearRaw !== null;
  const hasMonth = monthRaw !== null;
  const year = hasYear ? Number(yearRaw) : null;
  const month = hasMonth ? Number(monthRaw) : null;

  if (hasYear !== hasMonth) {
    console.error("Use --year and --month together.");
    process.exit(1);
  }
  if (hasYear && (!Number.isInteger(year) || year < 2000 || year > 2100)) {
    console.error("Invalid --year (expected 2000-2100).");
    process.exit(1);
  }
  if (hasMonth && (!Number.isInteger(month) || month < 1 || month > 12)) {
    console.error("Invalid --month (expected 1-12).");
    process.exit(1);
  }

  try {
    let createdOrRegenerated = false;
    let current = await requestJsonWithOwnerRetry(port, "GET", "/api/shares");
    if (!current.res.ok) {
      const msg = current.payload?.error || `Share lookup failed (${current.res.status}).`;
      console.error(msg);
      process.exit(1);
    }
    let share = current.payload?.share || null;

    if (!share && create) {
      const created = await requestJsonWithOwnerRetry(port, "POST", "/api/shares", { mode });
      if (!created.res.ok) {
        const msg = created.payload?.error || `Share create failed (${created.res.status}).`;
        console.error(msg);
        process.exit(1);
      }
      share = {
        token: created.payload?.shareToken || null,
        mode,
        is_active: true,
        shareUrl: created.payload?.shareUrl || null,
      };
      createdOrRegenerated = true;
    }

    if (share && regenerate) {
      const reg = await requestJsonWithOwnerRetry(
        port,
        "POST",
        `/api/shares/${encodeURIComponent(String(share.token || ""))}/regenerate`
      );
      if (!reg.res.ok) {
        const msg = reg.payload?.error || `Share regenerate failed (${reg.res.status}).`;
        console.error(msg);
        process.exit(1);
      }
      share = {
        token: reg.payload?.shareToken || null,
        mode: share.mode || mode,
        is_active: true,
        shareUrl: reg.payload?.shareUrl || null,
      };
      createdOrRegenerated = true;
    }

    if (share && disable) {
      const patch = await requestJsonWithOwnerRetry(
        port,
        "PATCH",
        `/api/shares/${encodeURIComponent(String(share.token || ""))}`,
        { isActive: false }
      );
      if (!patch.res.ok) {
        const msg = patch.payload?.error || `Share disable failed (${patch.res.status}).`;
        console.error(msg);
        process.exit(1);
      }
      share = null;
    }

    if (share && !disable && (publish || createdOrRegenerated)) {
      const publishBody = {};
      if (hasYear && hasMonth) {
        publishBody.year = year;
        publishBody.month = month;
      }
      const publishResult = await requestJsonWithOwnerRetry(
        port,
        "POST",
        `/api/shares/${encodeURIComponent(String(share.token || ""))}/publish-current`,
        publishBody
      );
      if (!publishResult.res.ok) {
        const msg = publishResult.payload?.error || `Share publish failed (${publishResult.res.status}).`;
        console.error(msg);
        process.exit(1);
      }
    }

    if (!share) {
      if (disable) {
        console.log("Share link disabled.");
      } else {
        console.log("No active share link.");
        console.log("Run with --create to create one.");
      }
      return;
    }

    const urlRaw = String(share.shareUrl || "").trim();
    const url = await maybeResolveLanShareUrl(port, urlRaw, share.token || "");
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            mode: share.mode || "live",
            active: !!share.is_active,
            token: share.token || null,
            url: url || null,
          },
          null,
          2
        )
      );
      return;
    }
    console.log(`mode: ${share.mode || "live"}`);
    console.log(`active: ${share.is_active ? "yes" : "no"}`);
    if (share.token) console.log(`token: ${share.token}`);
    if (url) {
      console.log(`url: ${url}`);
      if (copy && maybeCopyText(url)) {
        console.log("Copied to clipboard.");
      }
      if (autoOpen) {
        maybeOpenUrl(url);
        console.log("Opened share URL.");
      }
    } else {
      console.log("url: unavailable");
    }
  } catch (err) {
    console.error("Share command failed. Is the server running?", err.message);
    process.exit(1);
  }
}

function formatActionRow(row) {
  const id = String(row?.action_id || "").slice(0, 12);
  const type = String(row?.type || "").padEnd(22, " ");
  const status = String(row?.status || "").padEnd(8, " ");
  const created = String(row?.created_at || "");
  return `${id}  ${status}  ${type}  ${created}`;
}

async function doActionsList() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  const limitRaw = Number(argValue("--limit") || 20);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 20;
  const status = String(argValue("--status") || "").trim().toLowerCase();
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  if (status) qs.set("status", status);
  const url = `http://127.0.0.1:${port}/api/v1/actions?${qs.toString()}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Actions list failed (${res.status}). Is the server running on port ${port}?`);
      process.exit(1);
    }
    const data = await res.json();
    const rows = Array.isArray(data?.actions) ? data.actions : [];
    if (rows.length === 0) {
      console.log("No actions.");
      return;
    }
    console.log("action_id      status    type                    created_at");
    rows.forEach((row) => console.log(formatActionRow(row)));
  } catch (err) {
    console.error("Actions list failed. Is the server running?", err.message);
    process.exit(1);
  }
}

async function doActionGet() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  const id = String(argValue("--id") || "").trim();
  if (!id) {
    console.error("Missing --id for action command.");
    process.exit(1);
  }
  const url = `http://127.0.0.1:${port}/api/v1/actions/${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Action lookup failed (${res.status}).`);
      process.exit(1);
    }
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Action lookup failed. Is the server running?", err.message);
    process.exit(1);
  }
}

async function main() {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "backup") {
    await doBackup();
    return;
  }
  if (command === "health") {
    await doHealth();
    return;
  }
  if (command === "doctor") {
    await doDoctor();
    return;
  }
  if (command === "lan") {
    await doLan();
    return;
  }
  if (command === "export-json") {
    await doExportJson();
    return;
  }
  if (command === "diagnostics") {
    await doDiagnostics();
    return;
  }
  if (command === "clear-llm-cache") {
    await doClearLlmCache();
    return;
  }
  if (command === "mamdou-login") {
    await doMamdouLogin();
    return;
  }
  if (command === "mamdou-status") {
    await doMamdouStatus();
    return;
  }
  if (command === "mamdou-logout") {
    await doMamdouLogout();
    return;
  }
  if (command === "share-link") {
    await doShareLink();
    return;
  }
  if (command === "actions") {
    await doActionsList();
    return;
  }
  if (command === "action") {
    await doActionGet();
    return;
  }
  console.error("Unknown command:", command);
  usage();
  process.exit(1);
}

main();
