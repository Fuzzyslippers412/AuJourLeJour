/* Janitor: automated QA suite for Au Jour Le Jour */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const vm = require("vm");

const ledger = require("../ledger");

function log(line) {
  process.stdout.write(`${line}\n`);
}

function fail(line) {
  process.stderr.write(`${line}\n`);
}

function assertApprox(actual, expected, epsilon = 0.01) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `Expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function createWebAdapterSandbox() {
  const storage = new Map();
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(String(key), String(value));
    },
    removeItem(key) {
      storage.delete(String(key));
    },
    clear() {
      storage.clear();
    },
  };

  const upstreamCalls = [];
  const upstreamFetch = async (input) => {
    upstreamCalls.push(input);
    return new Response("upstream", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  };

  const windowObj = {
    fetch: upstreamFetch,
    localStorage,
    location: { origin: "https://example.test" },
    AJL_WEB_MODE: false,
  };

  const sandbox = {
    window: windowObj,
    localStorage,
    crypto: { randomUUID: () => `id_${Math.random().toString(36).slice(2)}` },
    URL,
    Request,
    Response,
    Headers,
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  const adapterSource = fs.readFileSync(
    path.join(__dirname, "..", "docs", "web-adapter.js"),
    "utf8"
  );
  vm.runInContext(adapterSource, sandbox, { filename: "web-adapter.js" });

  return { sandbox, upstreamCalls, storage };
}

async function run() {
  const start = Date.now();
  let passed = 0;
  let failed = 0;
  const tests = [];

  function test(name, fn) {
    tests.push({ name, fn });
  }

  // ----------------------------
  // Unit tests (ledger)
  // ----------------------------
  test("ledger.computeSummary handles partials", () => {
    const instances = [
      {
        amount: 100,
        amount_paid: 40,
        amount_remaining: 60,
        essential_snapshot: true,
        status_derived: "partial",
        due_date: "2026-02-10",
      },
    ];
    const summary = ledger.computeSummary(instances, {
      year: 2026,
      month: 2,
      essentialsOnly: true,
      todayDate: new Date("2026-02-12T00:00:00Z"),
    });
    assertApprox(summary.required_month, 100);
    assertApprox(summary.paid_month, 40);
    assertApprox(summary.remaining_month, 60);
  });

  test("ledger.clampDueDay clamps to last day of month", () => {
    const day = ledger.clampDueDay(2026, 2, 31);
    assert.strictEqual(day, 28);
  });

  // ----------------------------
  // Integration tests (server)
  // ----------------------------
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajl-janitor-"));
  process.env.AJL_DATA_DIR = tmpDir;
  process.env.AJL_DB_PATH = path.join(tmpDir, "ajl.sqlite");
  process.env.AJL_BACKUP_DIR = path.join(tmpDir, "backups");
  process.env.AJL_LOCK_FILE = path.join(tmpDir, "server.lock");
  process.env.AJL_DISABLE_LOCK = "1";
  process.env.PUBLIC_BASE_URL = "http://127.0.0.1";

  const { app, close } = require("../server");
  const server = await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";

  async function request(method, urlPath, body, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (cookie && opts.useCookie !== false) {
      headers.cookie = cookie;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie && opts.useCookie !== false) {
      cookie = setCookie.split(";")[0];
    }
    const contentType = res.headers.get("content-type") || "";
    let data = null;
    if (contentType.includes("application/json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    return { status: res.status, data, headers: res.headers };
  }

  let instanceId = null;
  let shareToken = null;
  let backup = null;
  const newActionId = () => `janitor_${Math.random().toString(36).slice(2)}`;

  test("api health responds ok", async () => {
    const res = await request("GET", "/api/health");
    assert.strictEqual(res.status, 200, `health status ${res.status}`);
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.app, "au-jour-le-jour");
    assert.strictEqual(res.data.mode, "local");
    assert.strictEqual(typeof res.data.app_version, "string");
    assert.strictEqual(typeof res.data.schema_version, "string");
  });

  test("api endpoints send no-store cache header", async () => {
    const res = await request("GET", "/api/settings");
    assert.strictEqual(res.status, 200);
    const cacheControl = (res.headers.get("cache-control") || "").toLowerCase();
    assert.ok(cacheControl.includes("no-store"));
  });

  test("security headers are present", async () => {
    const res = await request("GET", "/api/health");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(
      (res.headers.get("x-content-type-options") || "").toLowerCase(),
      "nosniff"
    );
    assert.strictEqual(
      (res.headers.get("x-frame-options") || "").toUpperCase(),
      "SAMEORIGIN"
    );
    assert.strictEqual(
      (res.headers.get("referrer-policy") || "").toLowerCase(),
      "no-referrer"
    );
  });

  test("safe route redirects to safe mode query", async () => {
    const res = await request("GET", "/safe", undefined, { useCookie: false });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.data, "string");
    assert.ok(res.data.includes("location.replace('/?safe=1')"));
  });

  test("reset route serves reset page", async () => {
    const res = await request("GET", "/reset", undefined, { useCookie: false });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.data, "string");
    assert.ok(res.data.includes("id=\"reset-btn\""));
    assert.ok(res.data.includes("Reset local data"));
  });

  test("settings defaults load", async () => {
    const res = await request("GET", "/api/settings");
    assert.strictEqual(res.status, 200, `settings status ${res.status}`);
    assert.strictEqual(res.data.hasCompletedOnboarding, false);
  });

  test("invalid year/month input is rejected", async () => {
    const checks = [
      "/api/instances?year=1999&month=2",
      "/api/instances?year=2026&month=13",
      "/api/v1/summary?year=2200&month=2",
      "/api/v1/month?year=2026&month=0",
      "/api/export/month.csv?year=1900&month=1",
    ];
    for (const url of checks) {
      const res = await request("GET", url);
      assert.strictEqual(res.status, 400, `Expected 400 for ${url}, got ${res.status}`);
    }
  });

  test("lan endpoint returns structured response", async () => {
    const res = await request("GET", "/api/lan");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.ok(Array.isArray(res.data.addresses));
    assert.ok(Array.isArray(res.data.urls));
  });

  test("sqlite export endpoint returns downloadable file", async () => {
    const res = await request("GET", "/api/export/sqlite");
    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get("content-type") || "";
    const disposition = res.headers.get("content-disposition") || "";
    assert.ok(contentType.includes("application/octet-stream"));
    assert.ok(disposition.includes("au_jour_le_jour.sqlite"));
  });

  test("qwen oauth status endpoint is reachable", async () => {
    const res = await request("GET", "/api/llm/qwen/oauth/status");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.data.connected, "boolean");
  });

  test("advisor endpoint is deterministic when not connected", async () => {
    const res = await request("POST", "/internal/advisor/query", {
      prompt: "healthcheck",
    });
    assert.ok(
      res.status === 200 || res.status === 400 || res.status === 503,
      `Unexpected advisor status: ${res.status}`
    );
    if (res.status === 503 || res.status === 400) {
      const asText = JSON.stringify(res.data || {});
      assert.ok(
        asText.toLowerCase().includes("connect") ||
          asText.toLowerCase().includes("oauth") ||
          asText.toLowerCase().includes("unavailable") ||
          asText.toLowerCase().includes("required"),
        "Expected a clear unavailable/connect/validation message for advisor"
      );
    }
  });

  test("invalid template input returns 400", async () => {
    const res = await request("POST", "/api/templates", {
      name: "",
      amount_default: -5,
      due_day: 0,
    });
    assert.strictEqual(res.status, 400);
  });

  test("template create + instance generation", async () => {
    const res = await request(
      "POST",
      "/api/templates?year=2026&month=2",
      {
        name: "Rent",
        category: "Housing",
        amount_default: 100,
        due_day: 31,
        autopay: false,
        essential: true,
        active: true,
      }
    );
    assert.strictEqual(res.status, 200, `template status ${res.status}`);
    const instanceRes = await request(
      "GET",
      "/api/instances?year=2026&month=2"
    );
    assert.strictEqual(instanceRes.status, 200);
    assert.strictEqual(instanceRes.data.length, 1);
    assert.strictEqual(instanceRes.data[0].due_date, "2026-02-28");
    instanceId = instanceRes.data[0].id;
  });

  test("ensure-month is idempotent", async () => {
    await request("GET", "/api/ensure-month?year=2026&month=2");
    const instanceRes = await request(
      "GET",
      "/api/instances?year=2026&month=2"
    );
    assert.strictEqual(instanceRes.data.length, 1);
  });

  test("partial update adjusts summary", async () => {
    const payRes = await request(
      "POST",
      `/api/instances/${instanceId}/payments`,
      { amount: 40, paid_date: "2026-02-05" }
    );
    assert.strictEqual(payRes.status, 200, `payment status ${payRes.status}`);
    assertApprox(payRes.data.instance.amount_paid, 40);
    const summaryRes = await request(
      "GET",
      "/api/v1/summary?year=2026&month=2"
    );
    assertApprox(summaryRes.data.paid_month, 40);
    assertApprox(summaryRes.data.remaining_month, 60);
  });

  test("mark done zeros remaining", async () => {
    const res = await request(
      "POST",
      `/api/instances/${instanceId}/mark-paid`
    );
    assert.strictEqual(res.status, 200, `mark status ${res.status}`);
    assert.strictEqual(res.data.status_derived, "paid");
    const summaryRes = await request(
      "GET",
      "/api/v1/summary?year=2026&month=2"
    );
    assertApprox(summaryRes.data.remaining_month, 0);
  });

  test("v1 summary contract shape", async () => {
    const res = await request("GET", "/api/v1/summary?year=2026&month=2");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.data.app, "string");
    assert.strictEqual(typeof res.data.schema_version, "string");
    assert.strictEqual(typeof res.data.period, "string");
    assert.strictEqual(typeof res.data.required_month, "number");
    assert.strictEqual(typeof res.data.paid_month, "number");
    assert.strictEqual(typeof res.data.remaining_month, "number");
    assert.strictEqual(typeof res.data.need_daily_exact, "number");
    assert.strictEqual(typeof res.data.need_weekly_exact, "number");
    assert.strictEqual(typeof res.data.free_for_month, "boolean");
  });

  test("v1 month contract shape", async () => {
    const res = await request("GET", "/api/v1/month?year=2026&month=2");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.data.app, "string");
    assert.strictEqual(typeof res.data.schema_version, "string");
    assert.strictEqual(typeof res.data.period, "string");
    assert.ok(Array.isArray(res.data.items));
    assert.ok(res.data.items.length >= 1);
    const first = res.data.items[0];
    const requiredKeys = [
      "instance_id",
      "template_id",
      "name",
      "amount",
      "due_date",
      "status",
      "autopay",
      "essential",
    ];
    requiredKeys.forEach((key) => {
      assert.ok(Object.prototype.hasOwnProperty.call(first, key), `Missing key: ${key}`);
    });
  });

  test("v1 templates contract shape", async () => {
    const res = await request("GET", "/api/v1/templates");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.data.app, "string");
    assert.strictEqual(typeof res.data.schema_version, "string");
    assert.ok(Array.isArray(res.data.templates));
    assert.ok(res.data.templates.length >= 1);
    const first = res.data.templates[0];
    assert.strictEqual(typeof first.id, "string");
    assert.strictEqual(typeof first.name, "string");
    assert.strictEqual(typeof Number(first.amount_default), "number");
  });

  test("undo restores remaining", async () => {
    const res = await request(
      "POST",
      `/api/instances/${instanceId}/undo-paid`
    );
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.status_derived, "pending");
    const summaryRes = await request(
      "GET",
      "/api/v1/summary?year=2026&month=2"
    );
    assertApprox(summaryRes.data.remaining_month, 100);
  });

  test("instance edits are logged", async () => {
    const res = await request(
      "PATCH",
      `/api/instances/${instanceId}`,
      { amount: 120, due_date: "2026-02-15", name_snapshot: "Rent Updated" }
    );
    assert.strictEqual(res.status, 200);
    const eventsRes = await request(
      "GET",
      `/api/instances/${instanceId}/events`
    );
    const types = new Set(eventsRes.data.map((e) => e.type));
    assert.ok(types.has("edited"));
  });

  test("events include updates + status changes", async () => {
    const eventsRes = await request(
      "GET",
      `/api/instances/${instanceId}/events`
    );
    const types = new Set(eventsRes.data.map((e) => e.type));
    assert.ok(types.has("log_update"));
    assert.ok(types.has("marked_done"));
    assert.ok(types.has("status_changed"));
  });

  test("invalid payment amount is rejected", async () => {
    const res = await request(
      "POST",
      `/api/instances/${instanceId}/payments`,
      { amount: -1 }
    );
    assert.strictEqual(res.status, 400);
  });

  test("skip and unskip via actions", async () => {
    const skipRes = await request("POST", "/api/v1/actions", {
      action_id: newActionId(),
      type: "SKIP_INSTANCE",
      instance_id: instanceId,
    });
    assert.strictEqual(skipRes.status, 200);
    assert.strictEqual(skipRes.data.instance.status, "skipped");

    const pendingRes = await request("POST", "/api/v1/actions", {
      action_id: newActionId(),
      type: "MARK_PENDING",
      instance_id: instanceId,
    });
    assert.strictEqual(pendingRes.status, 200);
    assert.strictEqual(pendingRes.data.instance.status, "pending");
  });

  test("unknown action type returns 400", async () => {
    const res = await request("POST", "/api/v1/actions", {
      action_id: newActionId(),
      type: "DO_NOT_EXIST",
    });
    assert.strictEqual(res.status, 400);
    assert.ok(
      typeof res.data.error === "string" || typeof res.data.error === "object"
    );
  });

  test("missing action type returns 400", async () => {
    const res = await request("POST", "/api/v1/actions", {
      action_id: newActionId(),
    });
    assert.strictEqual(res.status, 400);
  });

  test("mark paid with missing instance returns 400", async () => {
    const res = await request("POST", "/api/v1/actions", {
      action_id: newActionId(),
      type: "MARK_PAID",
      instance_id: "missing-instance-id",
    });
    assert.strictEqual(res.status, 400);
  });

  test("update instance fields via actions", async () => {
    const res = await request("POST", "/api/v1/actions", {
      action_id: newActionId(),
      type: "UPDATE_INSTANCE_FIELDS",
      instance_id: instanceId,
      amount: 155,
      due_date: "2026-02-20",
      note: "Janitor update",
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.instance.amount, 155);
    assert.strictEqual(res.data.instance.due_date, "2026-02-20");
  });

  test("month settings roundtrip", async () => {
    const setRes = await request("POST", "/api/month-settings", {
      year: 2026,
      month: 2,
      cash_start: 0,
    });
    assert.strictEqual(setRes.status, 200);
    const getRes = await request(
      "GET",
      "/api/month-settings?year=2026&month=2"
    );
    assert.strictEqual(getRes.data.cash_start, 0);
  });

  test("chat history roundtrip + clear", async () => {
    const addRes = await request("POST", "/api/chat", {
      role: "user",
      text: "janitor chat ping",
      meta: "test",
    });
    assert.strictEqual(addRes.status, 200);

    const listRes = await request("GET", "/api/chat?limit=10");
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(listRes.data.ok, true);
    assert.ok(Array.isArray(listRes.data.items));
    assert.ok(listRes.data.items.some((item) => item.text === "janitor chat ping"));

    const clearRes = await request("DELETE", "/api/chat");
    assert.strictEqual(clearRes.status, 200);

    const listAfter = await request("GET", "/api/chat?limit=10");
    assert.strictEqual(listAfter.status, 200);
    assert.strictEqual(listAfter.data.items.length, 0);
  });

  test("agent command log roundtrip", async () => {
    const postRes = await request("POST", "/internal/agent/log", {
      kind: "command",
      user_text: "mark rent done",
      summary: "mark done test",
      status: "ok",
      payload: { action: "MARK_PAID" },
      result: { ok: true },
    });
    assert.strictEqual(postRes.status, 200);

    const listRes = await request("GET", "/internal/agent/log?limit=5");
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(listRes.data.ok, true);
    assert.ok(Array.isArray(listRes.data.items));
    assert.ok(
      listRes.data.items.some((item) => item.user_text === "mark rent done")
    );
  });

  test("sinking fund action creates view", async () => {
    const actionRes = await request("POST", "/api/v1/actions", {
      action_id: newActionId(),
      type: "CREATE_FUND",
      name: "Insurance Annual",
      target_amount: 240,
      due_date: "2026-04-01",
      cadence: "yearly",
      months_per_cycle: 12,
      essential: true,
      active: true,
      auto_contribute: true,
    });
    assert.strictEqual(actionRes.status, 200);
    const fundsRes = await request(
      "GET",
      "/api/sinking-funds?year=2026&month=2"
    );
    assert.ok(Array.isArray(fundsRes.data));
    assert.strictEqual(fundsRes.data.length, 1);
  });

  test("auto-contribute creates sinking event", async () => {
    const fundsRes = await request(
      "GET",
      "/api/sinking-funds?year=2026&month=2"
    );
    const fundId = fundsRes.data[0]?.id;
    assert.ok(fundId);
    await request("GET", "/api/ensure-month?year=2026&month=2");
    const eventsRes = await request(
      "GET",
      `/api/sinking-events?fund_id=${fundId}`
    );
    assert.ok(Array.isArray(eventsRes.data));
    assert.ok(eventsRes.data.length > 0);
  });

  test("mark fund paid rolls due date forward", async () => {
    const fundsRes = await request(
      "GET",
      "/api/sinking-funds?year=2026&month=2"
    );
    const fund = fundsRes.data[0];
    const res = await request("POST", "/api/v1/actions", {
      action_id: newActionId(),
      type: "MARK_FUND_PAID",
      fund_id: fund.id,
      amount: fund.target_amount,
      event_date: "2026-02-10",
    });
    assert.strictEqual(res.status, 200);
    const updated = await request(
      "GET",
      "/api/sinking-funds?year=2026&month=2"
    );
    assert.ok(updated.data[0].due_date !== fund.due_date);
  });

  test("share link lifecycle", async () => {
    const shareRes = await request("POST", "/api/shares", {
      mode: "live",
      owner_label: "Test",
    });
    assert.strictEqual(shareRes.status, 200);
    shareToken = shareRes.data.shareToken;
    assert.ok(shareToken);
    assert.ok(shareToken.length >= 24);

    const publishRes = await request(
      "POST",
      `/api/shares/${shareToken}/publish`,
      {
        schema_version: "2",
        payload: { items: [], period: "2026-02" },
      }
    );
    assert.strictEqual(publishRes.status, 200);

    const viewRes = await request(
      "GET",
      `/api/shares/${shareToken}`,
      undefined,
      { useCookie: false }
    );
    assert.strictEqual(viewRes.status, 200);
    assert.ok(Array.isArray(viewRes.data.payload.items));
    assert.strictEqual(viewRes.headers.get("set-cookie"), null);

    const regenRes = await request(
      "POST",
      `/api/shares/${shareToken}/regenerate`
    );
    assert.strictEqual(regenRes.status, 200);

    const oldRes = await request(
      "GET",
      `/api/shares/${shareToken}`,
      undefined,
      { useCookie: false }
    );
    assert.ok(oldRes.status === 410 || oldRes.status === 404);
  });

  test("share disable blocks access", async () => {
    const shareRes = await request("POST", "/api/shares", { mode: "live" });
    const token = shareRes.data.shareToken;
    assert.ok(token);
    const disableRes = await request("PATCH", `/api/shares/${token}`, {
      isActive: false,
    });
    assert.strictEqual(disableRes.status, 200);
    const viewRes = await request(
      "GET",
      `/api/shares/${token}`,
      undefined,
      { useCookie: false }
    );
    assert.strictEqual(viewRes.status, 410);
  });

  test("share management endpoints require owner cookie", async () => {
    const token = "missing_or_fake_token_1234567890AB";
    const checks = [
      ["GET", "/api/shares"],
      ["POST", "/api/shares", { mode: "live" }],
      ["PATCH", `/api/shares/${token}`, { isActive: false }],
      ["POST", `/api/shares/${token}/regenerate`, {}],
      ["POST", `/api/shares/${token}/publish`, { schema_version: "2", payload: { items: [] } }],
    ];

    for (const [method, url, body] of checks) {
      const res = await request(method, url, body, { useCookie: false });
      assert.strictEqual(
        res.status,
        401,
        `Expected 401 for ${method} ${url}, got ${res.status}`
      );
    }
  });

  test("share public lookup is rate limited", async () => {
    let sawRateLimit = false;
    for (let i = 0; i < 75; i += 1) {
      const token = `missing_share_token_${String(i).padStart(2, "0")}__ABCDEFGHijklmnop`;
      const res = await request(
        "GET",
        `/api/shares/${token}`,
        undefined,
        { useCookie: false }
      );
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
      assert.ok(
        res.status === 404 || res.status === 410 || res.status === 400,
        `Unexpected status for share lookup: ${res.status}`
      );
    }
    assert.strictEqual(sawRateLimit, true, "Expected share lookup rate limit to trigger");
  });

  test("invalid share token is rejected", async () => {
    const checks = [
      [
        "GET",
        "/api/shares/short",
        undefined,
        { useCookie: false, headers: { "x-forwarded-for": "198.51.100.99" } },
      ],
      ["PATCH", "/api/shares/short", { isActive: false }, { useCookie: true }],
      ["POST", "/api/shares/short/regenerate", {}, { useCookie: true }],
      ["POST", "/api/shares/short/publish", { payload: { items: [] } }, { useCookie: true }],
    ];
    for (const [method, url, body, opts] of checks) {
      const res = await request(method, url, body, opts);
      assert.strictEqual(res.status, 400, `Expected 400 for ${method} ${url}, got ${res.status}`);
    }
  });

  test("export/import roundtrip", async () => {
    const exportRes = await request("GET", "/api/export/backup.json");
    assert.strictEqual(exportRes.status, 200);
    backup = exportRes.data;
    assert.ok(Array.isArray(backup.templates));

    const resetRes = await request("POST", "/api/reset-local");
    assert.strictEqual(resetRes.status, 200);
    const templatesAfterReset = await request("GET", "/api/templates");
    assert.strictEqual(templatesAfterReset.data.length, 0);

    const importRes = await request("POST", "/api/import/backup", backup);
    assert.strictEqual(importRes.status, 200);
    const templatesAfterImport = await request("GET", "/api/templates");
    assert.ok(templatesAfterImport.data.length > 0);
  });

  test("shutdown server", async () => {
    await new Promise((resolve) => server.close(resolve));
    close();
  });

  // ----------------------------
  // Static checks
  // ----------------------------
  test("static UI copy does not include forbidden terms", () => {
    const files = [
      path.join(__dirname, "..", "public", "index.html"),
      path.join(__dirname, "..", "public", "app.js"),
      path.join(__dirname, "..", "docs", "index.html"),
      path.join(__dirname, "..", "docs", "app.js"),
    ];
    const forbidden = [
      "Mark paid",
      "Pay full",
      "Cash on hand",
      "Coverage",
      "Confirm payment",
    ];
    files.forEach((file) => {
      const content = fs.readFileSync(file, "utf8");
      forbidden.forEach((phrase) => {
        assert.ok(
          !content.includes(phrase),
          `Forbidden phrase "${phrase}" found in ${file}`
        );
      });
    });
  });

  test("landing hero copy present in both builds", () => {
    const files = [
      path.join(__dirname, "..", "public", "index.html"),
      path.join(__dirname, "..", "docs", "index.html"),
    ];
    files.forEach((file) => {
      const content = fs.readFileSync(file, "utf8");
      assert.ok(content.includes("Private bill tracker"));
      assert.ok(content.includes("Know what’s due. Stay in control."));
      assert.ok(content.includes("Import your backup"));
    });
  });

  test("landing hero copy matches final spec in both builds", () => {
    const files = [
      path.join(__dirname, "..", "public", "index.html"),
      path.join(__dirname, "..", "docs", "index.html"),
    ];
    const requiredPhrases = [
      "Private bill tracker",
      "Know what’s due. Stay in control.",
      "Au Jour Le Jour gives you a clear monthly view of your bills so you always know what’s coming up, what’s overdue, and what’s already handled — without connecting to your bank accounts.",
      "Clear monthly view of upcoming and overdue bills",
      "Fast mark-done workflow with full history",
      "Local-first with export and backup control",
      "Import your backup",
      "Create your first template",
      "No financial connections. Your data stays under your control.",
    ];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      for (const phrase of requiredPhrases) {
        assert.ok(raw.includes(phrase), `${path.basename(file)} missing hero phrase: ${phrase}`);
      }
    }
  });

  test("required UI elements exist in both builds", () => {
    const files = [
      path.join(__dirname, "..", "public", "index.html"),
      path.join(__dirname, "..", "docs", "index.html"),
    ];
    files.forEach((file) => {
      const content = fs.readFileSync(file, "utf8");
      assert.ok(content.includes("first-visit-hero"));
      assert.ok(content.includes("summary-panel"));
      assert.ok(content.includes("mini-remaining-amount"));
      assert.ok(content.includes("mini-done-amount"));
    });
  });

  test("mini summary controls and inline panel exist in both builds", () => {
    const files = [
      path.join(__dirname, "..", "public", "index.html"),
      path.join(__dirname, "..", "docs", "index.html"),
    ];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      const requiredIds = [
        "status-bar",
        "status-expand",
        "summary-panel",
        "mini-remaining-amount",
        "mini-done-amount",
        "count-remaining",
        "count-overdue",
        "count-soon",
        "summary-count-done",
      ];
      requiredIds.forEach((id) => {
        assert.ok(raw.includes(`id=\"${id}\"`), `${path.basename(file)} missing ${id}`);
      });

      const statusIndex = raw.indexOf('id="status-bar"');
      const panelIndex = raw.indexOf('id="summary-panel"');
      const queueIndex = raw.indexOf('id="action-queue"');
      assert.ok(statusIndex >= 0, "status-bar index missing");
      assert.ok(panelIndex >= 0, "summary-panel index missing");
      assert.ok(queueIndex >= 0, "action-queue index missing");
      assert.ok(statusIndex < panelIndex, "summary panel must follow status bar");
      assert.ok(panelIndex < queueIndex, "summary panel must appear before action queue");
    }
  });

  test("today list virtualization primitives exist in both builds", () => {
    const files = [
      path.join(__dirname, "..", "public", "app.js"),
      path.join(__dirname, "..", "docs", "app.js"),
    ];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      const requiredSnippets = [
        "const rowHeight = getRowHeight();",
        "const scroll = document.createElement(\"div\");",
        "scroll.className = \"items-scroll\";",
        "const spacer = document.createElement(\"div\");",
        "spacer.style.height = `${list.length * rowHeight}px`;",
        "const renderWindow = () => {",
        "scroll.addEventListener(\"scroll\", renderWindow);",
      ];
      requiredSnippets.forEach((snippet) => {
        assert.ok(raw.includes(snippet), `${path.basename(file)} missing virtualization snippet: ${snippet}`);
      });
    }
  });

  test("split-view tablet layout rules exist in both builds", () => {
    const files = [
      path.join(__dirname, "..", "public", "styles.css"),
      path.join(__dirname, "..", "docs", "styles.css"),
    ];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      assert.ok(raw.includes("body.split-view .today-layout"), `${path.basename(file)} missing split-view layout`);
      assert.ok(raw.includes("grid-template-columns: minmax(0, 1fr) 360px;"), `${path.basename(file)} missing split-view two-column grid`);
      assert.ok(raw.includes("body.split-view #details-drawer"), `${path.basename(file)} missing split-view drawer hide rule`);
      assert.ok(raw.includes("display: none !important;"), `${path.basename(file)} missing split-view forced drawer hidden rule`);
    }
  });

  test("list row heights are fixed per breakpoint in both builds", () => {
    const files = [
      path.join(__dirname, "..", "public", "styles.css"),
      path.join(__dirname, "..", "docs", "styles.css"),
    ];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      assert.ok(
        raw.includes(".queue-row,\n.item-row,\n.list-row") &&
          raw.includes("height: 56px;"),
        `${path.basename(file)} missing fixed 56px base row height`
      );
      assert.ok(
        raw.includes("@media (min-width: 1024px)") && raw.includes("height: 64px;"),
        `${path.basename(file)} missing fixed 64px desktop row height`
      );
    }
  });

  test("integration contract file includes required v1 endpoints", () => {
    const contract = fs.readFileSync(
      path.join(__dirname, "..", "CONTRACT.md"),
      "utf8"
    );
    const required = [
      "GET /api/v1/summary",
      "GET /api/v1/month",
      "GET /api/v1/templates",
      "POST /api/v1/actions",
      "MARK_PAID",
      "UPDATE_INSTANCE_FIELDS",
      "GENERATE_MONTH",
    ];
    required.forEach((entry) => {
      assert.ok(contract.includes(entry), `Missing contract entry: ${entry}`);
    });
  });

  test("project policy docs exist and README references them", () => {
    const requiredFiles = ["CONTRACT.md", "CONTRIBUTING.md", "SECURITY.md"];
    requiredFiles.forEach((name) => {
      const filePath = path.join(__dirname, "..", name);
      assert.ok(fs.existsSync(filePath), `Missing ${name}`);
      const raw = fs.readFileSync(filePath, "utf8");
      assert.ok(raw.trim().length > 0, `${name} must not be empty`);
    });
    const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    requiredFiles.forEach((name) => {
      assert.ok(readme.includes(name), `README must reference ${name}`);
    });
  });

  test("repo docs do not contain absolute local home paths", () => {
    const textFiles = [
      path.join(__dirname, "..", "README.md"),
      path.join(__dirname, "..", "MYCASA_INTEGRATION_NOTES.md"),
      path.join(__dirname, "..", "CONTRACT.md"),
    ];
    const forbiddenFragments = ["/Users/", "C:\\Users\\"];
    for (const file of textFiles) {
      const raw = fs.readFileSync(file, "utf8");
      forbiddenFragments.forEach((fragment) => {
        assert.ok(
          !raw.includes(fragment),
          `Found forbidden absolute path fragment "${fragment}" in ${path.basename(file)}`
        );
      });
    }
  });

  test("seed files are sanitized for public repo use", () => {
    const files = [
      path.join(__dirname, "..", "seeds", "monthly_expenses.json"),
      path.join(__dirname, "..", "seeds", "notes.txt"),
    ];
    const blockedSnippets = [
      "Erika",
      "Xina",
      "Comcast",
      "Republic",
      "Tesla Car Payment",
      "YouTube TV",
    ];
    const ethAddressRegex = /\b0x[a-fA-F0-9]{40}\b/g;
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      blockedSnippets.forEach((snippet) => {
        assert.ok(
          !raw.includes(snippet),
          `Found blocked personal/provider marker "${snippet}" in ${path.basename(file)}`
        );
      });
      assert.ok(
        !ethAddressRegex.test(raw),
        `Found blockchain-style wallet address in ${path.basename(file)}`
      );
    }
  });

  test("ajl cli help command works", () => {
    const cliPath = path.join(__dirname, "ajl_cli.js");
    const result = spawnSync(process.execPath, [cliPath, "--help"], {
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr || "CLI exited non-zero");
    const out = `${result.stdout || ""}${result.stderr || ""}`;
    assert.ok(out.includes("AJL CLI"));
    assert.ok(out.includes("backup"));
    assert.ok(out.includes("export-json"));
  });

  test("start/stop scripts are valid bash syntax", () => {
    const scripts = [
      path.join(__dirname, "..", "start.sh"),
      path.join(__dirname, "..", "stop.sh"),
    ];
    for (const scriptPath of scripts) {
      const result = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
      assert.strictEqual(
        result.status,
        0,
        `Syntax error in ${path.basename(scriptPath)}: ${result.stderr || result.stdout}`
      );
    }
  });

  test("web/local html entrypoints keep expected adapter wiring", () => {
    const publicIndex = fs.readFileSync(
      path.join(__dirname, "..", "public", "index.html"),
      "utf8"
    );
    const docsIndex = fs.readFileSync(
      path.join(__dirname, "..", "docs", "index.html"),
      "utf8"
    );

    assert.ok(
      publicIndex.includes('<script src="/app.js"></script>'),
      "public/index.html must load /app.js"
    );
    assert.ok(
      !publicIndex.includes("web-adapter.js"),
      "public/index.html must not load web-adapter.js"
    );
    assert.ok(
      docsIndex.includes('<script src="./web-adapter.js"></script>'),
      "docs/index.html must load ./web-adapter.js"
    );
    assert.ok(
      docsIndex.includes('<script src="./app.js"></script>'),
      "docs/index.html must load ./app.js"
    );
  });

  test("web reset pages clear all local browser state", () => {
    const resetPages = [
      path.join(__dirname, "..", "docs", "reset.html"),
      path.join(__dirname, "..", "docs", "reset", "index.html"),
    ];
    for (const pagePath of resetPages) {
      const raw = fs.readFileSync(pagePath, "utf8");
      assert.ok(raw.includes("localStorage.clear()"), `${pagePath} must clear localStorage`);
      assert.ok(raw.includes("sessionStorage.clear()"), `${pagePath} must clear sessionStorage`);
      assert.ok(
        raw.includes("indexedDB.databases") || raw.includes("indexedDB.deleteDatabase"),
        `${pagePath} must clear indexedDB`
      );
      assert.ok(raw.includes("caches.keys()"), `${pagePath} must clear caches`);
      assert.ok(
        raw.includes("serviceWorker") && raw.includes("unregister"),
        `${pagePath} must unregister service workers`
      );
      assert.ok(raw.includes("location.replace('/')"), `${pagePath} must redirect to root`);
    }
  });

  test("web utility route files are consistent", () => {
    const pairs = [
      ["docs/reset.html", "docs/reset/index.html"],
      ["docs/safe.html", "docs/safe/index.html"],
    ];
    for (const [a, b] of pairs) {
      const aPath = path.join(__dirname, "..", a);
      const bPath = path.join(__dirname, "..", b);
      assert.ok(fs.existsSync(aPath), `${a} is missing`);
      assert.ok(fs.existsSync(bPath), `${b} is missing`);
      const aRaw = fs.readFileSync(aPath, "utf8").trim();
      const bRaw = fs.readFileSync(bPath, "utf8").trim();
      assert.strictEqual(bRaw, aRaw, `${b} drifted from ${a}`);
    }
  });

  test("docs/index.html is synchronized from public/index.html transform", () => {
    const publicIndex = fs.readFileSync(
      path.join(__dirname, "..", "public", "index.html"),
      "utf8"
    );
    const docsIndex = fs.readFileSync(
      path.join(__dirname, "..", "docs", "index.html"),
      "utf8"
    );

    const expectedDocs = publicIndex
      .replace(
        '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
        '<link rel="icon" href="./favicon.svg" type="image/svg+xml" />'
      )
      .replace(
        '<link rel="stylesheet" href="/styles.css" />',
        '<link rel="stylesheet" href="./styles.css" />'
      )
      .replace(
        '<script src="/app.js"></script>',
        '<script src="./web-adapter.js"></script>\n    <script src="./app.js"></script>'
      );

    assert.strictEqual(
      docsIndex,
      expectedDocs,
      "docs/index.html drifted from transformed public/index.html. Run: npm run sync:web"
    );
  });

  test("docs mirrored assets match public source", () => {
    const pairs = [
      ["public/app.js", "docs/app.js"],
      ["public/styles.css", "docs/styles.css"],
      ["public/favicon.svg", "docs/favicon.svg"],
    ];
    for (const [from, to] of pairs) {
      const fromPath = path.join(__dirname, "..", from);
      const toPath = path.join(__dirname, "..", to);
      const fromRaw = fs.readFileSync(fromPath, "utf8");
      const toRaw = fs.readFileSync(toPath, "utf8");
      assert.strictEqual(
        toRaw,
        fromRaw,
        `${to} differs from ${from}. Run: npm run sync:web`
      );
    }
  });

  test("server bootstrap functions are not duplicated", () => {
    const serverFile = path.join(__dirname, "..", "server.js");
    const source = fs.readFileSync(serverFile, "utf8");

    const mustAppearOnce = [
      /^function initSchema\(/gm,
      /^function migrateLegacySchema\(/gm,
      /^function migrateLegacyPayments\(/gm,
      /^function nowIso\(/gm,
      /^function ensureDailyBackup\(/gm,
      /^initSchema\(\);/gm,
      /^migrateLegacyPayments\(\);/gm,
      /^app\.use\(express\.json\(\{ limit: "2mb" \}\)\);/gm,
    ];

    for (const pattern of mustAppearOnce) {
      const matches = source.match(pattern) || [];
      assert.strictEqual(
        matches.length,
        1,
        `Expected one match for ${pattern}, found ${matches.length}`
      );
    }
  });

  test("server route declarations are unique per method+path", () => {
    const serverFile = path.join(__dirname, "..", "server.js");
    const source = fs.readFileSync(serverFile, "utf8");
    const routeRegex = /app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
    const counts = new Map();
    let match = routeRegex.exec(source);
    while (match) {
      const key = `${match[1].toUpperCase()} ${match[2]}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      match = routeRegex.exec(source);
    }
    const duplicates = Array.from(counts.entries()).filter(([, count]) => count > 1);
    assert.strictEqual(
      duplicates.length,
      0,
      `Duplicate routes found: ${duplicates.map(([k, c]) => `${k} x${c}`).join(", ")}`
    );
  });

  test("server top-level function names are unique", () => {
    const serverFile = path.join(__dirname, "..", "server.js");
    const source = fs.readFileSync(serverFile, "utf8");
    const fnRegex = /^function\s+([A-Za-z0-9_]+)\s*\(/gm;
    const counts = new Map();
    let match = fnRegex.exec(source);
    while (match) {
      const name = match[1];
      counts.set(name, (counts.get(name) || 0) + 1);
      match = fnRegex.exec(source);
    }
    const duplicates = Array.from(counts.entries()).filter(([, count]) => count > 1);
    assert.strictEqual(
      duplicates.length,
      0,
      `Duplicate function declarations found: ${duplicates
        .map(([name, count]) => `${name} x${count}`)
        .join(", ")}`
    );
  });

  test("web adapter covers app API usage or explicit local-only exceptions", () => {
    const appSource = fs.readFileSync(
      path.join(__dirname, "..", "public", "app.js"),
      "utf8"
    );
    const adapterSource = fs.readFileSync(
      path.join(__dirname, "..", "docs", "web-adapter.js"),
      "utf8"
    );

    const endpointMethods = new Map();

    const fetchWithMethodRegex =
      /fetch\(\s*(['"`])([^'"`]+)\1\s*,\s*\{[\s\S]{0,200}?method:\s*(['"`])([A-Z]+)\3[\s\S]{0,200}?\}\s*\)/gm;
    let match = fetchWithMethodRegex.exec(appSource);
    while (match) {
      const endpoint = String(match[2] || "").trim();
      const method = String(match[4] || "GET").toUpperCase();
      if (!endpoint.startsWith("/api/")) {
        match = fetchWithMethodRegex.exec(appSource);
        continue;
      }
      if (!endpointMethods.has(endpoint)) endpointMethods.set(endpoint, new Set());
      endpointMethods.get(endpoint).add(method);
      match = fetchWithMethodRegex.exec(appSource);
    }

    const fetchDefaultRegex = /fetch\(\s*(['"`])([^'"`]+)\1\s*\)/gm;
    match = fetchDefaultRegex.exec(appSource);
    while (match) {
      const endpoint = String(match[2] || "").trim();
      if (!endpoint.startsWith("/api/")) {
        match = fetchDefaultRegex.exec(appSource);
        continue;
      }
      if (!endpointMethods.has(endpoint)) endpointMethods.set(endpoint, new Set());
      endpointMethods.get(endpoint).add("GET");
      match = fetchDefaultRegex.exec(appSource);
    }

    const supportedPatterns = [];
    const unavailablePrefixes = [];
    const supportsChatBlock = adapterSource.includes('if (path === "/api/chat")');

    const eqRegex = /if \(path === "([^"]+)" && req\.method === "([A-Z]+)"\)/g;
    match = eqRegex.exec(adapterSource);
    while (match) {
      supportedPatterns.push({
        type: "eq",
        endpoint: match[1],
        method: match[2],
      });
      match = eqRegex.exec(adapterSource);
    }

    const startsWithAnyMethodRegex = /if \(path\.startsWith\("([^"]+)"\)\) \{/g;
    match = startsWithAnyMethodRegex.exec(adapterSource);
    while (match) {
      unavailablePrefixes.push(match[1]);
      match = startsWithAnyMethodRegex.exec(adapterSource);
    }

    const startsWithMethodRegex =
      /if \(path\.startsWith\("([^"]+)"\) && [\s\S]{0,140}?req\.method === "([A-Z]+)"\)/g;
    match = startsWithMethodRegex.exec(adapterSource);
    while (match) {
      supportedPatterns.push({
        type: "prefix",
        endpoint: match[1],
        method: match[2],
      });
      match = startsWithMethodRegex.exec(adapterSource);
    }

    const dynamicPatterns = [
      { endpointRegex: /^\/api\/templates\/\$\{.*\}\/archive$/, method: "POST", prefix: "/api/templates/" },
      { endpointRegex: /^\/api\/templates\/\$\{.*\}$/, method: "PUT", prefix: "/api/templates/" },
      { endpointRegex: /^\/api\/templates\/\$\{.*\}$/, method: "DELETE", prefix: "/api/templates/" },
      { endpointRegex: /^\/api\/instances\/\$\{.*\}\/payments$/, method: "POST", prefix: "/api/instances/" },
      { endpointRegex: /^\/api\/instances\/\$\{.*\}\/undo-paid$/, method: "POST", prefix: "/api/instances/" },
      { endpointRegex: /^\/api\/instances\/\$\{.*\}$/, method: "PATCH", prefix: "/api/instances/" },
      { endpointRegex: /^\/api\/payments\/\$\{.*\}$/, method: "DELETE", prefix: "/api/payments/" },
      { endpointRegex: /^\/api\/shares\/\$\{.*\}\/publish$/, method: "POST", prefix: "/api/shares/" },
      { endpointRegex: /^\/api\/shares\/\$\{.*\}\/regenerate$/, method: "POST", prefix: "/api/shares/" },
      { endpointRegex: /^\/api\/shares\/\$\{.*\}$/, method: "PATCH", prefix: "/api/shares/" },
      { endpointRegex: /^\/api\/shares\/\$\{.*\}$/, method: "GET", prefix: "/api/shares/" },
    ];

    const explicitLocalOnlyPrefixes = [
      "/api/llm/",
      "/api/lan",
      "/api/export/sqlite",
      "/api/shares",
    ];

    const missing = [];
    for (const [endpoint, methods] of endpointMethods.entries()) {
      for (const method of methods) {
        const endpointPath = endpoint.split("?")[0];
        const isExplicitLocalOnly = explicitLocalOnlyPrefixes.some((prefix) =>
          endpointPath.startsWith(prefix)
        );
        if (isExplicitLocalOnly) continue;

        if (
          supportsChatBlock &&
          endpointPath === "/api/chat" &&
          (method === "GET" || method === "POST" || method === "DELETE")
        ) {
          continue;
        }

        const exactSupported = supportedPatterns.some(
          (entry) =>
            entry.type === "eq" &&
            entry.endpoint === endpointPath &&
            entry.method === method
        );
        if (exactSupported) continue;

        const prefixSupported = supportedPatterns.some(
          (entry) =>
            entry.type === "prefix" &&
            method === entry.method &&
            endpointPath.startsWith(entry.endpoint)
        );
        if (prefixSupported) continue;

        const dynamicSupported = dynamicPatterns.some(
          (entry) =>
            entry.method === method &&
            entry.endpointRegex.test(endpoint) &&
            endpointPath.startsWith(entry.prefix)
        );
        if (dynamicSupported) continue;

        const unavailableByPrefix = unavailablePrefixes.some((prefix) =>
          endpointPath.startsWith(prefix)
        );
        if (unavailableByPrefix) continue;

        missing.push(`${method} ${endpoint}`);
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `Web adapter missing endpoint support for: ${missing.join(", ")}`
    );
  });

  test("web adapter runtime handles core API flows", async () => {
    const { sandbox, upstreamCalls } = createWebAdapterSandbox();
    const base = "https://example.test";

    assert.strictEqual(!!sandbox.window.AJL_WEB_MODE, true);

    const healthRes = await sandbox.window.fetch(`${base}/api/health`);
    assert.strictEqual(healthRes.status, 200);
    assert.ok(
      (healthRes.headers.get("cache-control") || "").toLowerCase().includes("no-store")
    );
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.ok, true);
    assert.strictEqual(healthData.data.app, "au-jour-le-jour");
    assert.strictEqual(healthData.data.mode, "web");
    assert.strictEqual(typeof healthData.data.app_version, "string");
    assert.strictEqual(typeof healthData.data.schema_version, "string");

    const createTemplateRes = await sandbox.window.fetch(
      `${base}/api/templates?year=2026&month=2`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Web Rent",
          category: "Housing",
          amount_default: 100,
          due_day: 10,
          essential: true,
          active: true,
        }),
      }
    );
    assert.ok(
      createTemplateRes.status === 200 || createTemplateRes.status === 201,
      `Unexpected template create status: ${createTemplateRes.status}`
    );

    const templatesRes = await sandbox.window.fetch(`${base}/api/templates`);
    assert.strictEqual(templatesRes.status, 200);
    const templatesData = await templatesRes.json();
    assert.strictEqual(Array.isArray(templatesData.data), true);
    assert.strictEqual(templatesData.data.length, 1);
    assert.strictEqual(templatesData.data[0].name, "Web Rent");

    const instancesRes = await sandbox.window.fetch(
      `${base}/api/instances?year=2026&month=2`
    );
    assert.strictEqual(instancesRes.status, 200);
    const instancesData = await instancesRes.json();
    assert.strictEqual(Array.isArray(instancesData.data), true);
    assert.strictEqual(instancesData.data.length, 1);
    const instanceId = instancesData.data[0].id;
    assert.strictEqual(typeof instanceId, "string");

    const payRes = await sandbox.window.fetch(
      `${base}/api/instances/${instanceId}/payments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 35 }),
      }
    );
    assert.strictEqual(payRes.status, 200);
    const payData = await payRes.json();
    assert.strictEqual(payData.ok, true);
    assert.strictEqual(typeof payData.data.instance.amount_paid, "number");
    assert.ok(payData.data.instance.amount_paid >= 35);

    const summaryRes = await sandbox.window.fetch(
      `${base}/api/v1/summary?year=2026&month=2`
    );
    assert.strictEqual(summaryRes.status, 200);
    const summaryData = await summaryRes.json();
    assert.strictEqual(summaryData.ok, true);
    assert.strictEqual(typeof summaryData.data.required_month, "number");
    assert.ok(summaryData.data.paid_month >= 35);

    const exportRes = await sandbox.window.fetch(`${base}/api/export/backup.json`);
    assert.strictEqual(exportRes.status, 200);
    const exportData = await exportRes.json();
    assert.strictEqual(exportData.ok, true);
    assert.ok(Array.isArray(exportData.data.templates));
    assert.strictEqual(exportData.data.templates.length, 1);

    const resetRes = await sandbox.window.fetch(`${base}/api/reset-local`, {
      method: "POST",
    });
    assert.strictEqual(resetRes.status, 200);
    const afterResetTemplatesRes = await sandbox.window.fetch(`${base}/api/templates`);
    const afterResetTemplates = await afterResetTemplatesRes.json();
    assert.strictEqual(afterResetTemplates.data.length, 0);

    const importRes = await sandbox.window.fetch(`${base}/api/import/backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportData.data),
    });
    assert.strictEqual(importRes.status, 200);

    const invalidImportRes = await sandbox.window.fetch(
      `${base}/api/import/backup`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schema_version: "999", templates: {} }),
      }
    );
    assert.strictEqual(invalidImportRes.status, 400);

    const afterImportTemplatesRes = await sandbox.window.fetch(`${base}/api/templates`);
    const afterImportTemplates = await afterImportTemplatesRes.json();
    assert.strictEqual(Array.isArray(afterImportTemplates.data), true);
    assert.strictEqual(afterImportTemplates.data.length, 1);

    const sharesRes = await sandbox.window.fetch(`${base}/api/shares`, {
      method: "GET",
    });
    assert.strictEqual(sharesRes.status, 503);

    const advisorRes = await sandbox.window.fetch(`${base}/internal/advisor/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    assert.strictEqual(advisorRes.status, 503);
    const advisorData = await advisorRes.json();
    assert.strictEqual(advisorData.ok, false);
    assert.ok(
      String(advisorData.error?.message || "").toLowerCase().includes("local app only")
    );

    const passthroughRes = await sandbox.window.fetch(`${base}/not-api`);
    assert.strictEqual(passthroughRes.status, 200);
    assert.strictEqual(upstreamCalls.length >= 1, true);
  });

  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      log(`✔ ${t.name}`);
    } catch (err) {
      failed += 1;
      fail(`✖ ${t.name}`);
      fail(`  ${err.message}`);
    }
  }

  const duration = ((Date.now() - start) / 1000).toFixed(2);
  log(`\nJanitor complete: ${passed} passed, ${failed} failed (${duration}s)`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  fail(`Janitor crashed: ${err.message}`);
  process.exit(1);
});
