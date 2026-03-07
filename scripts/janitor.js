/* Janitor: automated QA suite for Au Jour Le Jour */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync, spawn } = require("child_process");
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

function createWebAdapterSandbox(options = {}) {
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
  const upstreamFetch = async (input, init) => {
    upstreamCalls.push({ input, init: init || {} });
    const url = String(input || "");
    if (url.includes("/api/shares")) {
      return new Response(
        JSON.stringify({
          ok: true,
          shareToken: "relay_share_token_abcdefghijklmnopqrstuvwxyz",
          shareUrl: "https://aujourlejour.xyz/?share=relay_share_token_abcdefghijklmnopqrstuvwxyz",
          ownerKey: "relay_owner_key_abcdefghijklmnopqrstuvwxyz",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("upstream", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  };

  if (options.ownerKey) {
    storage.set("ajl_share_owner_key", String(options.ownerKey));
  }

  const windowObj = {
    fetch: upstreamFetch,
    localStorage,
    location: { origin: "https://example.test" },
    AJL_SHARE_BASE_URL: options.shareBaseUrl || "",
    AJL_SHARE_VIEWER_BASE_URL: options.viewerBaseUrl || "https://example.test",
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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForUrl(url, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      // ignore while waiting
    }
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopChildProcess(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once("exit", finish);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 1500);
    setTimeout(finish, 3500);
  });
}

async function run() {
  const start = Date.now();
  let passed = 0;
  let failed = 0;
  const tests = [];
  const results = [];

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

  const { app, close, db } = require("../server");
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
    assert.strictEqual(typeof res.data.pid, "number");
    assert.ok(res.data.pid > 0);
    assert.strictEqual(typeof res.data.uptime_sec, "number");
    assert.strictEqual(typeof res.data.started_at, "string");
    const requestId = res.headers.get("x-request-id");
    assert.ok(requestId && requestId.length >= 8, "missing x-request-id header");
  });

  test("metrics endpoint responds with telemetry shape", async () => {
    const res = await request("GET", "/api/metrics");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(typeof res.data.uptime_sec, "number");
    assert.ok(res.data.metrics && typeof res.data.metrics === "object");
    assert.strictEqual(typeof res.data.metrics.requests_total, "number");
    assert.strictEqual(typeof res.data.metrics.mutation_requests, "number");
    assert.strictEqual(typeof res.data.metrics.llm_requests, "number");
    assert.strictEqual(typeof res.data.metrics.llm_cache_hits, "number");
    assert.strictEqual(typeof res.data.metrics.llm_timeouts, "number");
    assert.strictEqual(typeof res.data.metrics.llm_cache_entries, "number");
    assert.strictEqual(typeof res.data.metrics.actions_replayed, "number");
    assert.strictEqual(typeof res.data.metrics.actions_conflicted, "number");
  });

  test("diagnostics cache clear endpoint works", async () => {
    const res = await request("POST", "/api/system/diagnostics/clear-llm-cache", {});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(typeof res.data.cleared, "number");
  });

  test("diagnostics endpoint returns runtime + llm + share details", async () => {
    const res = await request("GET", "/api/system/diagnostics");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(typeof res.data.request_id, "string");
    assert.strictEqual(typeof res.data.runtime?.uptime_sec, "number");
    assert.strictEqual(typeof res.data.limits?.llm_route_timeout_ms, "number");
    assert.strictEqual(typeof res.data.llm?.connected, "boolean");
    assert.strictEqual(typeof res.data.llm?.cache_entries, "number");
    assert.strictEqual(typeof res.data.share?.viewer_base_url, "string");
    assert.strictEqual(typeof res.data.storage?.db_file, "string");
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
    assert.strictEqual(typeof res.data.share_viewer_base_url, "string");
    assert.ok(res.data.share_viewer_base_url.startsWith("http"));
    assert.ok(res.data.defaults && typeof res.data.defaults === "object");
    assert.ok(["auto", "manual"].includes(String(res.data.defaults.progressBasis || "")));
    assert.ok(["ytd", "full"].includes(String(res.data.defaults.yearScope || "")));
    assert.strictEqual(typeof Number(res.data.defaults.monthlyGoalAmount), "number");
    assert.strictEqual(typeof Number(res.data.defaults.yearlyGoalAmount), "number");
  });

  test("progress endpoint returns monthly and yearly progress shape", async () => {
    const res = await request("GET", "/api/progress?year=2026&month=2&essentials_only=true&year_scope=ytd");
    assert.strictEqual(res.status, 200, `progress status ${res.status}`);
    assert.strictEqual(typeof res.data.period, "string");
    assert.ok(["auto", "manual"].includes(String(res.data.basis || "")));
    assert.ok(["ytd", "full"].includes(String(res.data.year_scope || "")));
    assert.strictEqual(typeof res.data.essentials_only, "boolean");
    assert.ok(res.data.month && typeof res.data.month === "object");
    assert.ok(res.data.year && typeof res.data.year === "object");
    ["required", "done", "remaining", "target", "target_remaining", "percent"].forEach((key) => {
      assert.strictEqual(typeof Number(res.data.month[key]), "number", `month.${key} must be numeric`);
      assert.strictEqual(typeof Number(res.data.year[key]), "number", `year.${key} must be numeric`);
    });
    assert.strictEqual(typeof Number(res.data.year.months_in_scope), "number");
  });

  test("manual progress goals override auto targets", async () => {
    const save = await request("POST", "/api/settings", {
      defaults: {
        sort: "due_date",
        dueSoonDays: 7,
        defaultPeriod: "month",
        progressBasis: "manual",
        monthlyGoalAmount: 250,
        yearlyGoalAmount: 3000,
        yearScope: "full",
      },
      categories: [],
      hasCompletedOnboarding: false,
    });
    assert.strictEqual(save.status, 200);
    const res = await request("GET", "/api/progress?year=2026&month=2&essentials_only=true&year_scope=full");
    assert.strictEqual(res.status, 200, `progress manual status ${res.status}`);
    assert.strictEqual(res.data.basis, "manual");
    assert.strictEqual(res.data.year_scope, "full");
    assert.strictEqual(Number(res.data.month.target), 250);
    assert.strictEqual(Number(res.data.year.target), 3000);
    assert.strictEqual(Number(res.data.year.months_in_scope), 12);
    const restore = await request("POST", "/api/settings", {
      defaults: {
        sort: "due_date",
        dueSoonDays: 7,
        defaultPeriod: "month",
        progressBasis: "auto",
        monthlyGoalAmount: 0,
        yearlyGoalAmount: 0,
        yearScope: "ytd",
      },
      categories: [],
      hasCompletedOnboarding: false,
    });
    assert.strictEqual(restore.status, 200);
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
    assert.strictEqual(res.data.urls.length, res.data.addresses.length);
    for (const url of res.data.urls) {
      assert.strictEqual(typeof url, "string");
      assert.ok(url.startsWith("http://"));
    }
  });

  test("sqlite export endpoint returns downloadable file", async () => {
    const res = await request("GET", "/api/export/sqlite");
    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get("content-type") || "";
    const disposition = res.headers.get("content-disposition") || "";
    assert.ok(contentType.includes("application/octet-stream"));
    assert.ok(disposition.includes("au_jour_le_jour.sqlite"));
  });

  test("receipt pdf export returns downloadable file", async () => {
    const res = await request("GET", "/api/export/receipt.pdf?year=2026&month=2&scope=ytd&essentials_only=true");
    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get("content-type") || "";
    const disposition = res.headers.get("content-disposition") || "";
    assert.ok(contentType.includes("application/pdf"));
    assert.ok(disposition.includes("au_jour_le_jour_receipt_2026_ytd.pdf"));
    assert.strictEqual(typeof res.data, "string");
    assert.ok(res.data.startsWith("%PDF-1.4"));
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

  test("action idempotency replays result without double mutation", async () => {
    const actionId = `janitor_idempotent_${Math.random().toString(36).slice(2)}`;
    const payload = {
      action_id: actionId,
      type: "ADD_PAYMENT",
      instance_id: instanceId,
      amount: 7.25,
      paid_date: "2026-02-21",
    };
    const first = await request("POST", "/api/v1/actions", payload);
    assert.strictEqual(first.status, 200);
    assert.ok(first.data?.payment?.id);

    const second = await request("POST", "/api/v1/actions", payload);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.data?.payment?.id, first.data?.payment?.id);

    const paymentsRes = await request("GET", "/api/payments?year=2026&month=2");
    assert.strictEqual(paymentsRes.status, 200);
    const matching = (paymentsRes.data || []).filter(
      (row) => row.id === first.data.payment.id
    );
    assert.strictEqual(matching.length, 1);
  });

  test("action audit endpoint returns stored action status/result", async () => {
    const actionId = `janitor_action_lookup_${Math.random().toString(36).slice(2)}`;
    const runRes = await request("POST", "/api/v1/actions", {
      action_id: actionId,
      type: "UPDATE_INSTANCE_FIELDS",
      instance_id: instanceId,
      note: "lookup-test",
    });
    assert.strictEqual(runRes.status, 200);

    const lookupRes = await request("GET", `/api/v1/actions/${actionId}`);
    assert.strictEqual(lookupRes.status, 200);
    assert.strictEqual(lookupRes.data.ok, true);
    assert.strictEqual(lookupRes.data.action.action_id, actionId);
    assert.strictEqual(lookupRes.data.action.status, "ok");
    assert.strictEqual(lookupRes.data.action.result.action_id, actionId);

    const listRes = await request("GET", "/api/v1/actions?limit=10&status=ok");
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(listRes.data.ok, true);
    assert.ok(Array.isArray(listRes.data.actions));
    assert.ok(
      listRes.data.actions.some((entry) => entry.action_id === actionId),
      "action list should include the created action"
    );
  });

  test("duplicate action id while pending returns 409", async () => {
    const actionId = `janitor_pending_${Math.random().toString(36).slice(2)}`;
    db.prepare(
      "INSERT INTO actions (id, type, payload, created_at, status, result) VALUES (?, ?, ?, ?, ?, NULL)"
    ).run(
      actionId,
      "ADD_PAYMENT",
      JSON.stringify({ action_id: actionId, type: "ADD_PAYMENT" }),
      new Date().toISOString(),
      "pending"
    );

    const res = await request("POST", "/api/v1/actions", {
      action_id: actionId,
      type: "ADD_PAYMENT",
      instance_id: instanceId,
      amount: 1,
      paid_date: "2026-02-22",
    });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.data.ok, false);
    assert.strictEqual(res.data.status, "pending");
    assert.strictEqual(res.data.action_id, actionId);
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
    assert.ok(typeof shareRes.data.shareUrl === "string");
    assert.ok(shareRes.data.shareUrl.includes("?share="));
    assert.ok(typeof shareRes.data.ownerKey === "string");

    const publishRes = await request(
      "POST",
      `/api/shares/${shareToken}/publish`,
      {
        schema_version: "2",
        payload: { items: [], period: "2026-02" },
      }
    );
    assert.strictEqual(publishRes.status, 200);

    const publishCurrentRes = await request(
      "POST",
      `/api/shares/${shareToken}/publish-current`,
      { year: 2026, month: 2 }
    );
    assert.strictEqual(publishCurrentRes.status, 200);
    assert.strictEqual(publishCurrentRes.data.ok, true);
    assert.strictEqual(publishCurrentRes.data.period, "2026-02");
    assert.ok(Number.isInteger(Number(publishCurrentRes.data.items)));

    const viewRes = await request(
      "GET",
      `/api/shares/${shareToken}`,
      undefined,
      { useCookie: false }
    );
    assert.strictEqual(viewRes.status, 200);
    assert.ok(Array.isArray(viewRes.data.payload.items));
    assert.strictEqual(viewRes.headers.get("set-cookie"), null);
    const etag = viewRes.headers.get("etag");
    assert.ok(typeof etag === "string" && etag.length > 8, "missing ETag on share view");

    const notModified = await request(
      "GET",
      `/api/shares/${shareToken}`,
      undefined,
      { useCookie: false, headers: { "if-none-match": etag } }
    );
    assert.strictEqual(notModified.status, 304);

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

  test("creating a new share deactivates previous active share", async () => {
    const first = await request("POST", "/api/shares", {
      mode: "live",
      owner_label: "First",
    });
    assert.strictEqual(first.status, 200);
    const firstToken = first.data.shareToken;
    assert.ok(firstToken);

    const firstPublish = await request("POST", `/api/shares/${firstToken}/publish`, {
      schema_version: "1",
      payload: {
        schema_version: "1",
        period: "2026-03",
        items: [{ id: "one", name_snapshot: "One", due_date: "2026-03-01", status: "pending" }],
      },
    });
    assert.strictEqual(firstPublish.status, 200);

    const second = await request("POST", "/api/shares", {
      mode: "snapshot",
      owner_label: "Second",
    });
    assert.strictEqual(second.status, 200);
    const secondToken = second.data.shareToken;
    assert.ok(secondToken && secondToken !== firstToken);

    const firstView = await request("GET", `/api/shares/${firstToken}`, undefined, {
      useCookie: false,
    });
    assert.strictEqual(firstView.status, 410);

    const ownerView = await request("GET", "/api/shares");
    assert.strictEqual(ownerView.status, 200);
    assert.ok(ownerView.data.share);
    assert.strictEqual(ownerView.data.share.token, secondToken);
  });

  test("share expiry is validated and persisted", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const create = await request("POST", "/api/shares", {
      mode: "live",
      owner_label: "Expiry QA",
      expires_at: future,
    });
    assert.strictEqual(create.status, 200);
    const token = create.data.shareToken;
    assert.ok(token);
    assert.strictEqual(typeof create.data.expires_at, "string");

    const ownerView = await request("GET", "/api/shares");
    assert.strictEqual(ownerView.status, 200);
    assert.ok(ownerView.data.share);

    const publish = await request("POST", `/api/shares/${token}/publish`, {
      schema_version: "1",
      payload: {
        schema_version: "1",
        period: "2026-03",
        items: [
          {
            id: "expiry-test-1",
            name_snapshot: "Expiry test",
            due_date: "2026-03-01",
            status: "pending",
          },
        ],
      },
    });
    assert.strictEqual(publish.status, 200);

    const tokenView = await request("GET", `/api/shares/${token}`, undefined, {
      useCookie: false,
    });
    assert.strictEqual(tokenView.status, 200);
    assert.strictEqual(typeof tokenView.data.expiresAt, "string");

    const invalidExpiryCreate = await request("POST", "/api/shares", {
      mode: "live",
      expires_at: "not-a-date",
    });
    assert.strictEqual(invalidExpiryCreate.status, 400);

    const pastExpiryPatch = await request("PATCH", `/api/shares/${token}`, {
      expires_at: new Date(Date.now() - 10_000).toISOString(),
    });
    assert.strictEqual(pastExpiryPatch.status, 400);

    const clearExpiry = await request("PATCH", `/api/shares/${token}`, {
      expires_at: null,
    });
    assert.strictEqual(clearExpiry.status, 200);

    const soon = new Date(Date.now() + 250).toISOString();
    const shortCreate = await request("POST", "/api/shares", {
      mode: "live",
      owner_label: "Short expiry",
      expires_at: soon,
    });
    assert.strictEqual(shortCreate.status, 200);
    const shortToken = shortCreate.data.shareToken;
    assert.ok(shortToken);

    await sleep(350);

    const shortPublic = await request("GET", `/api/shares/${shortToken}`, undefined, {
      useCookie: false,
    });
    assert.strictEqual(shortPublic.status, 410);

    const ownerAfterExpire = await request("GET", "/api/shares");
    assert.strictEqual(ownerAfterExpire.status, 200);
    if (ownerAfterExpire.data.share) {
      assert.notStrictEqual(ownerAfterExpire.data.share.token, shortToken);
    }
  });

  test("share payload preserves privacy redaction fields", async () => {
    const create = await request("POST", "/api/shares", {
      mode: "snapshot",
      owner_label: "Privacy",
    });
    assert.strictEqual(create.status, 200);
    const token = create.data.shareToken;
    assert.ok(token);

    const publish = await request(
      "POST",
      `/api/shares/${token}/publish`,
      {
        schema_version: "1",
        payload: {
          schema_version: "1",
          period: "2026-03",
          privacy: {
            include_amounts: false,
            include_notes: false,
            include_categories: true,
          },
          items: [
            {
              id: "sample-1",
              name_snapshot: "Rent",
              due_date: "2026-03-01",
              status: "pending",
              amount: null,
              amount_paid: null,
              amount_remaining: null,
              note: null,
            },
          ],
          categories: ["Housing"],
        },
      }
    );
    assert.strictEqual(publish.status, 200);

    const view = await request("GET", `/api/shares/${token}`, undefined, {
      useCookie: false,
    });
    assert.strictEqual(view.status, 200);
    assert.strictEqual(view.data.payload.privacy.include_amounts, false);
    assert.strictEqual(view.data.payload.items[0].amount, null);
    assert.strictEqual(view.data.payload.items[0].amount_remaining, null);
  });

  test("bridge share relay lifecycle + payload validation", async () => {
    const bridgeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ajl-bridge-janitor-"));
    const bridgePort = 18080 + Math.floor(Math.random() * 500);
    const bridgeEnv = {
      ...process.env,
      PORT: String(bridgePort),
      HOST: "127.0.0.1",
      DATA_DIR: bridgeTmp,
      DB_FILE: path.join(bridgeTmp, "bridge.sqlite"),
      COOKIE_SECURE: "false",
      ALLOWED_ORIGINS: "*",
      SHARE_VIEWER_BASE_URL: "https://aujourlejour.xyz",
    };

    const bridgeProc = spawn("node", [path.join(__dirname, "..", "bridge", "server.js")], {
      env: bridgeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    bridgeProc.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    const bridgeBase = `http://127.0.0.1:${bridgePort}`;
    const bridgeRequest = async (method, urlPath, body, headers = {}) => {
      const res = await fetch(`${bridgeBase}${urlPath}`, {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const contentType = res.headers.get("content-type") || "";
      const data = contentType.includes("application/json") ? await res.json() : await res.text();
      return { status: res.status, data, headers: res.headers };
    };

    try {
      await waitForUrl(`${bridgeBase}/api/health`, 12_000);

      const health = await bridgeRequest("GET", "/api/health");
      assert.strictEqual(health.status, 200);
      assert.strictEqual(health.data.ok, true);
      assert.strictEqual(health.data.app, "ajl-share-relay");
      const metrics = await bridgeRequest("GET", "/api/metrics");
      assert.strictEqual(metrics.status, 200);
      assert.strictEqual(metrics.data.ok, true);
      assert.strictEqual(typeof metrics.data.metrics.requests_total, "number");
      assert.strictEqual(typeof metrics.data.metrics.share_lookups, "number");
      assert.strictEqual(typeof metrics.data.metrics.llm_requests, "number");

      const bridgeExpiry = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
      const create = await bridgeRequest("POST", "/api/shares", {
        mode: "live",
        owner_label: "Bridge QA",
        expires_at: bridgeExpiry,
      });
      assert.strictEqual(create.status, 200, `bridge create failed: ${JSON.stringify(create.data)}`);
      const token = create.data.shareToken;
      const ownerKey = create.data.ownerKey;
      assert.ok(typeof token === "string" && token.length >= 24);
      assert.ok(typeof ownerKey === "string" && ownerKey.length >= 24);
      assert.strictEqual(typeof create.data.expires_at, "string");

      const unauthorizedOwnerRead = await bridgeRequest("GET", "/api/shares");
      assert.strictEqual(unauthorizedOwnerRead.status, 401);

      const ownerRead = await bridgeRequest("GET", "/api/shares", undefined, {
        "X-AJL-Share-Owner": ownerKey,
      });
      assert.strictEqual(ownerRead.status, 200);
      assert.ok(ownerRead.data.share);
      assert.strictEqual(typeof ownerRead.data.share.expires_at, "string");

      const invalidPublish = await bridgeRequest(
        "POST",
        `/api/shares/${token}/publish`,
        {
          schema_version: "1",
          payload: {
            schema_version: "1",
            period: "2026-03",
            items: [{ id: "bad", name_snapshot: "Bad item", status: "pending" }],
          },
        },
        { "X-AJL-Share-Owner": ownerKey }
      );
      assert.strictEqual(invalidPublish.status, 400);

      const publish = await bridgeRequest(
        "POST",
        `/api/shares/${token}/publish`,
        {
          schema_version: "1",
          payload: {
            schema_version: "1",
            period: "2026-03",
            privacy: {
              include_amounts: false,
              include_notes: true,
              include_categories: true,
            },
            items: [
              {
                id: "bridge-1",
                template_id: "tmpl-1",
                year: 2026,
                month: 3,
                name_snapshot: "Bridge Rent",
                category_snapshot: "Housing",
                amount: null,
                due_date: "2026-03-01",
                status: "pending",
                paid_date: null,
                amount_paid: null,
                amount_remaining: null,
                essential_snapshot: true,
                autopay_snapshot: false,
                note: null,
              },
            ],
            categories: ["Housing"],
          },
        },
        { "X-AJL-Share-Owner": ownerKey }
      );
      assert.strictEqual(publish.status, 200, `bridge publish failed: ${JSON.stringify(publish.data)}`);

      const invalidExpiryPatch = await bridgeRequest(
        "PATCH",
        `/api/shares/${token}`,
        { expires_at: "not-a-date" },
        { "X-AJL-Share-Owner": ownerKey }
      );
      assert.strictEqual(invalidExpiryPatch.status, 400);

      const publicView = await bridgeRequest("GET", `/api/shares/${token}`);
      assert.strictEqual(publicView.status, 200);
      assert.strictEqual(publicView.data.payload.privacy.include_amounts, false);
      assert.strictEqual(publicView.data.payload.items[0].amount, null);
      const bridgeEtag = publicView.headers.get("etag");
      assert.ok(typeof bridgeEtag === "string" && bridgeEtag.length > 8);
      const bridgeNotModified = await bridgeRequest(
        "GET",
        `/api/shares/${token}`,
        undefined,
        { "if-none-match": bridgeEtag }
      );
      assert.strictEqual(bridgeNotModified.status, 304);

      const regen = await bridgeRequest(
        "POST",
        `/api/shares/${token}/regenerate`,
        {},
        { "X-AJL-Share-Owner": ownerKey }
      );
      assert.strictEqual(regen.status, 200);
      assert.ok(typeof regen.data.shareToken === "string" && regen.data.shareToken !== token);

      const oldTokenView = await bridgeRequest("GET", `/api/shares/${token}`);
      assert.ok(oldTokenView.status === 404 || oldTokenView.status === 410);

      const newTokenView = await bridgeRequest("GET", `/api/shares/${regen.data.shareToken}`);
      assert.strictEqual(newTokenView.status, 200);

      const secondCreate = await bridgeRequest(
        "POST",
        "/api/shares",
        {
          mode: "snapshot",
          owner_label: "Bridge QA second",
        },
        { "X-AJL-Share-Owner": ownerKey }
      );
      assert.strictEqual(secondCreate.status, 200);
      const secondToken = secondCreate.data.shareToken;
      assert.ok(typeof secondToken === "string" && secondToken !== regen.data.shareToken);

      const priorView = await bridgeRequest("GET", `/api/shares/${regen.data.shareToken}`);
      assert.strictEqual(priorView.status, 410);

      const ownerAfterSecond = await bridgeRequest("GET", "/api/shares", undefined, {
        "X-AJL-Share-Owner": ownerKey,
      });
      assert.strictEqual(ownerAfterSecond.status, 200);
      assert.ok(ownerAfterSecond.data.share);
      assert.strictEqual(ownerAfterSecond.data.share.token, secondToken);

      const shortExpiry = new Date(Date.now() + 300).toISOString();
      const shortShare = await bridgeRequest("POST", "/api/shares", {
        mode: "live",
        owner_label: "Short bridge expiry",
        expires_at: shortExpiry,
      });
      assert.strictEqual(shortShare.status, 200);
      const shortToken = shortShare.data.shareToken;
      assert.ok(shortToken);

      await sleep(380);
      const shortPublic = await bridgeRequest("GET", `/api/shares/${shortToken}`);
      assert.strictEqual(shortPublic.status, 410);

      const shortPublish = await bridgeRequest(
        "POST",
        `/api/shares/${shortToken}/publish`,
        {
          schema_version: "1",
          payload: {
            schema_version: "1",
            period: "2026-03",
            items: [
              {
                id: "bridge-expired-1",
                name_snapshot: "Expired link item",
                due_date: "2026-03-01",
                status: "pending",
              },
            ],
          },
        },
        { "X-AJL-Share-Owner": shortShare.data.ownerKey }
      );
      assert.strictEqual(shortPublish.status, 410);
    } finally {
      await stopChildProcess(bridgeProc);
      if (stderr && bridgeProc.exitCode && bridgeProc.exitCode !== 0) {
        throw new Error(`Bridge process failed: ${stderr}`);
      }
    }
  });

  test("share management endpoints require owner auth", async () => {
    const token = "missing_or_fake_token_1234567890AB";
    const checks = [
      ["GET", "/api/shares"],
      ["POST", "/api/shares", { mode: "live" }],
      ["PATCH", `/api/shares/${token}`, { isActive: false }],
      ["POST", `/api/shares/${token}/regenerate`, {}],
      ["POST", `/api/shares/${token}/publish`, { schema_version: "2", payload: { items: [] } }],
      ["POST", `/api/shares/${token}/publish-current`, {}],
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

  test("share management endpoints accept owner header auth", async () => {
    const create = await request("POST", "/api/shares", { mode: "live" });
    assert.strictEqual(create.status, 200);
    const token = create.data.shareToken;
    const ownerKey = create.data.ownerKey;
    assert.ok(token);
    assert.ok(ownerKey);

    const withoutCookie = await request("GET", "/api/shares", undefined, {
      useCookie: false,
      headers: { "X-AJL-Share-Owner": ownerKey },
    });
    assert.strictEqual(withoutCookie.status, 200);
    assert.ok(withoutCookie.data.share);
    assert.strictEqual(withoutCookie.data.share.ownerKey, ownerKey);
    const managedToken = withoutCookie.data.share.token;
    assert.ok(typeof managedToken === "string" && managedToken.length >= 24);

    const patch = await request(
      "PATCH",
      `/api/shares/${managedToken}`,
      { mode: "snapshot" },
      { useCookie: false, headers: { "X-AJL-Share-Owner": ownerKey } }
    );
    assert.strictEqual(patch.status, 200);
  });

  test("share public lookup is rate limited", async () => {
    let sawRateLimit = false;
    const token = "missing_share_token_abcdefghijklmnopqrstuvwxyz";
    for (let i = 0; i < 130; i += 1) {
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
      ["POST", "/api/shares/short/publish-current", {}, { useCookie: true }],
    ];
    for (const [method, url, body, opts] of checks) {
      const res = await request(method, url, body, opts);
      assert.strictEqual(res.status, 400, `Expected 400 for ${method} ${url}, got ${res.status}`);
    }
    const invalidViewRoute = await request("GET", "/s/short", undefined, { useCookie: false });
    assert.strictEqual(invalidViewRoute.status, 404);
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
      assert.ok(content.includes('id="assistant-provider-select"'));
      assert.ok(content.includes('id="assistant-provider-connect"'));
      assert.ok(content.includes('id="assistant-provider-setup"'));
      assert.ok(content.includes('id="assistant-provider-hint"'));
      assert.ok(content.includes('id="shannon-run-llm-runtime"'));
      assert.ok(content.includes('value="llm-runtime"'));
      assert.ok(content.includes('value="skipped"'));
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

  test("share UI controls are enabled in both builds", () => {
    const files = [
      path.join(__dirname, "..", "public", "index.html"),
      path.join(__dirname, "..", "docs", "index.html"),
    ];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      assert.ok(raw.includes('id="share-open"'), `${path.basename(file)} missing share-open button`);
      assert.ok(raw.includes('id="share-modal"'), `${path.basename(file)} missing share modal`);
      assert.ok(raw.includes('id="share-include-amounts"'), `${path.basename(file)} missing share include amounts`);
      assert.ok(raw.includes('id="share-include-notes"'), `${path.basename(file)} missing share include notes`);
      assert.ok(raw.includes('id="share-include-categories"'), `${path.basename(file)} missing share include categories`);
      assert.ok(raw.includes('id="share-expiry"'), `${path.basename(file)} missing share expiry control`);
      assert.ok(raw.includes('id="share-expiry-custom"'), `${path.basename(file)} missing custom expiry input`);
      assert.ok(raw.includes('id="share-owner-label"'), `${path.basename(file)} missing share owner label input`);
      assert.ok(raw.includes('id="share-refresh"'), `${path.basename(file)} missing share-refresh action`);
      assert.ok(raw.includes('id="share-relay-status"'), `${path.basename(file)} missing share relay status`);
      assert.ok(raw.includes('id="shared-updated"'), `${path.basename(file)} missing shared-updated field`);
      const shareOpenLine = raw.split("\n").find((line) => line.includes('id="share-open"')) || "";
      const shareModalLine = raw.split("\n").find((line) => line.includes('id="share-modal"')) || "";
      assert.ok(!shareOpenLine.includes("local-only"), `${path.basename(file)} share-open must not be local-only`);
      assert.ok(!shareModalLine.includes("local-only"), `${path.basename(file)} share-modal must not be local-only`);
    }
  });

  test("diagnostics controls exist in local and web html builds", () => {
    const files = [
      path.join(__dirname, "..", "public", "index.html"),
      path.join(__dirname, "..", "docs", "index.html"),
    ];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      assert.ok(raw.includes('id="diagnostics-section"'), `${path.basename(file)} missing diagnostics-section`);
      assert.ok(raw.includes('id="diagnostics-run"'), `${path.basename(file)} missing diagnostics-run`);
      assert.ok(raw.includes('id="diagnostics-clear-cache"'), `${path.basename(file)} missing diagnostics-clear-cache`);
      assert.ok(raw.includes('id="diagnostics-copy"'), `${path.basename(file)} missing diagnostics-copy`);
      assert.ok(raw.includes('id="diagnostics-output"'), `${path.basename(file)} missing diagnostics-output`);
    }
  });

  test("janitor page controls exist in local and web html builds", () => {
    const files = [
      path.join(__dirname, "..", "public", "index.html"),
      path.join(__dirname, "..", "docs", "index.html"),
    ];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      assert.ok(raw.includes('id="nav-janitor"'), `${path.basename(file)} missing nav-janitor`);
      assert.ok(raw.includes('id="janitor-view"'), `${path.basename(file)} missing janitor-view`);
      assert.ok(raw.includes('id="janitor-section"'), `${path.basename(file)} missing janitor-section`);
      assert.ok(raw.includes('id="shannon-run"'), `${path.basename(file)} missing janitor run button`);
      assert.ok(raw.includes('id="shannon-refresh"'), `${path.basename(file)} missing janitor refresh button`);
      assert.ok(raw.includes('id="shannon-copy"'), `${path.basename(file)} missing janitor copy button`);
      assert.ok(raw.includes('id="janitor-runtime-base"'), `${path.basename(file)} missing janitor runtime base input`);
      assert.ok(raw.includes('id="janitor-runtime-required"'), `${path.basename(file)} missing janitor runtime required toggle`);
      assert.ok(raw.includes("Run Janitor"), `${path.basename(file)} missing Run Janitor label`);
    }
  });

  test("janitor runtime controls are wired in app logic", () => {
    const appFile = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
    const requiredSnippets = [
      "JANITOR_RUNTIME_BASE_KEY",
      "JANITOR_RUNTIME_REQUIRED_KEY",
      "function loadJanitorRuntimeBase",
      "function loadJanitorRuntimeRequired",
      "function saveJanitorRuntimeSettings",
      "function syncJanitorRuntimeControls",
      "function applyJanitorRuntimeControlUpdate",
      "runtime_required:",
      "payload.runtime_base = runtimeBase",
      "els.janitorRuntimeBase.addEventListener(\"change\"",
      "els.janitorRuntimeRequired.addEventListener(\"change\"",
    ];
    requiredSnippets.forEach((snippet) => {
      assert.ok(appFile.includes(snippet), `public/app.js missing Janitor runtime wiring: ${snippet}`);
    });
  });

  test("share publish retry queue primitives exist in app", () => {
    const appFile = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
    assert.ok(appFile.includes("function flushSharePublishQueue()"), "flushSharePublishQueue missing");
    assert.ok(appFile.includes("getSharePublishRetryDelayMs"), "share retry delay helper missing");
    assert.ok(appFile.includes("Share relay timeout. Falling back to local service."), "relay fallback warning missing");
    assert.ok(appFile.includes("shareRelayBackoffUntil"), "share relay backoff state missing");
    assert.ok(
      appFile.includes("Share relay unavailable. Try again in a few seconds."),
      "web relay unavailable message missing"
    );
    assert.ok(appFile.includes("function setShareBusy("), "setShareBusy helper missing");
  });

  test("share token routing supports query and path", () => {
    const appFile = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
    assert.ok(
      appFile.includes("new URLSearchParams(window.location.search).get(\"share\")"),
      "public/app.js must parse share token from query params"
    );
    assert.ok(
      appFile.includes("window.location.pathname.match(/^\\/s\\/([A-Za-z0-9_-]{24,128})\\/?$/)"),
      "public/app.js must parse share token from /s/:token path"
    );
    assert.ok(
      appFile.includes("startSharedLivePolling"),
      "public/app.js must support live share polling for viewer mode"
    );
    assert.ok(
      appFile.includes("state.dataVersion += 1"),
      "public/app.js must bump dataVersion when shared payload refreshes"
    );
    assert.ok(
      appFile.includes("function parseFastCommand"),
      "public/app.js must include deterministic fast-path command parser"
    );
  });

  test("fast command parser covers high-frequency local actions", () => {
    const appFile = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
    const requiredSnippets = [
      "function parseFastEssentialsIntent",
      "function parseFastProgressIntent",
      "function parseFastExportIntent",
      "function parseFastBatchQueueIntent",
      "function parseFastTemplateMutationIntent",
      "function parseFastBulkTemplateIntent",
      "function parseFastInstanceMutationIntent",
      "function parseFastBulkInstanceIntent",
      "function parseFastShareIntent",
      "function parseFastAssistantIntent",
      "function parseFastQuestionIntent",
      "function resolveByName",
      "function formatAmbiguityMessage",
      "intent: \"MARK_ALL_OVERDUE\"",
      "intent: \"MARK_ALL_DUE_SOON\"",
      "intent: \"MARK_INSTANCES_BULK_DONE\"",
      "intent: \"MARK_INSTANCES_BULK_PENDING\"",
      "intent: \"SKIP_INSTANCES_BULK\"",
      "intent: \"EXPORT_BACKUP\"",
      "intent: \"EXPORT_RECEIPT\"",
      "intent: \"EXPORT_MONTH\"",
      "intent: \"SET_ESSENTIALS_ONLY\"",
      "intent: \"SET_PROGRESS_BASIS\"",
      "intent: \"SET_PROGRESS_MONTHLY_GOAL\"",
      "intent: \"SET_PROGRESS_YEARLY_GOAL\"",
      "intent: \"SET_PROGRESS_YEAR_SCOPE\"",
      "intent: \"SHOW_PROGRESS\"",
      "intent: \"UPDATE_INSTANCE_FIELDS\"",
      "intent: \"UPDATE_AMOUNT_FLEX\"",
      "intent: \"CREATE_TEMPLATES_BULK\"",
      "intent: \"DELETE_TEMPLATES_BULK\"",
      "intent: \"ARCHIVE_TEMPLATES_BULK\"",
      "intent: \"ACTIVATE_TEMPLATES_BULK\"",
      "intent: \"SHOW_SHARE\"",
      "intent: \"CREATE_SHARE\"",
      "intent: \"REFRESH_SHARE\"",
      "intent: \"DISABLE_SHARE\"",
      "intent: \"REGENERATE_SHARE\"",
      "intent: \"COPY_SHARE\"",
      "intent: \"SHOW_ASSISTANT\"",
      "intent: \"START_AGENT_AUTH\"",
      "intent: \"LOCAL_SUMMARY_REMAINING\"",
      "intent: \"LOCAL_SUMMARY_OVERDUE\"",
      "intent: \"LOCAL_SUMMARY_DUE_SOON\"",
      "intent: \"LOCAL_SUMMARY_FREE\"",
      "intent: \"LOCAL_SUMMARY_PROGRESS\"",
      "function normalizeMamdouProviderInput",
      "function getActiveMamdouConnectionState",
      "function isActiveMamdouConnected",
      "if (!isActiveMamdouConnected())",
      "with|to|using",
      "function parseFastMonthIntent",
      "FAST_MONTH_MAP",
      "function canAutoExecuteProposal",
      "AUTO_EXECUTE_INTENTS",
      "function logAutoAgentExecution",
      "progress:",
      "summary-year-scope",
    ];
    requiredSnippets.forEach((snippet) => {
      assert.ok(appFile.includes(snippet), `public/app.js missing fast parser snippet: ${snippet}`);
    });
  });

  test("web entrypoint defines share relay base config", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    const appSource = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
    const adapterSource = fs.readFileSync(path.join(__dirname, "..", "docs", "web-adapter.js"), "utf8");
    const hasIndexInlineConfig =
      html.includes("window.AJL_SHARE_BASE_URL") && html.includes("window.AJL_SHARE_VIEWER_BASE_URL");
    const hasRuntimeFallback =
      appSource.includes("https://agent.aujourlejour.xyz") &&
      adapterSource.includes("https://agent.aujourlejour.xyz");
    assert.ok(
      hasIndexInlineConfig || hasRuntimeFallback,
      "share relay base config must exist in index inline config or runtime fallback"
    );
  });

  test("web adapter exposes relay-backed share support hooks", () => {
    const adapter = fs.readFileSync(path.join(__dirname, "..", "docs", "web-adapter.js"), "utf8");
    assert.ok(adapter.includes("const SHARE_BASE_URL"), "web-adapter missing SHARE_BASE_URL config");
    assert.ok(adapter.includes("X-AJL-Share-Owner"), "web-adapter must pass owner key header");
    assert.ok(
      adapter.includes("if (path.startsWith(\"/api/shares\"))"),
      "web-adapter missing /api/shares branch"
    );
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

  test("migration framework exists", () => {
    const migrationFile = path.join(__dirname, "..", "migrations", "index.js");
    assert.ok(fs.existsSync(migrationFile), "Missing migrations/index.js");
    const raw = fs.readFileSync(migrationFile, "utf8");
    assert.ok(raw.includes("schema_migrations"), "Migration framework must track schema_migrations");
    assert.ok(raw.includes("runMigrations"), "Migration framework must export runMigrations");
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

  test("shipped client assets do not contain absolute local home paths", () => {
    const files = [
      path.join(__dirname, "..", "public", "app.js"),
      path.join(__dirname, "..", "docs", "app.js"),
      path.join(__dirname, "..", "public", "index.html"),
      path.join(__dirname, "..", "docs", "index.html"),
    ];
    const forbiddenFragments = ["/Users/", "C:\\Users\\", "chefmbororo"];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      forbiddenFragments.forEach((fragment) => {
        assert.ok(
          !raw.includes(fragment),
          `Found forbidden absolute path/personal fragment "${fragment}" in ${path.basename(file)}`
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
    assert.ok(out.includes("health"));
    assert.ok(out.includes("doctor"));
    assert.ok(out.includes("lan"));
    assert.ok(out.includes("backup"));
    assert.ok(out.includes("export-json"));
    assert.ok(out.includes("diagnostics"));
    assert.ok(out.includes("clear-llm-cache"));
    assert.ok(out.includes("janitor"));
    assert.ok(out.includes("janitor-status"));
    assert.ok(out.includes("--profile <name>"));
    assert.ok(out.includes("--runtime-base <url>"));
    assert.ok(out.includes("--runtime-required"));
    assert.ok(out.includes("--wait"));
    assert.ok(out.includes("mamdou-status"));
    assert.ok(out.includes("mamdou-login"));
    assert.ok(out.includes("mamdou-logout"));
    assert.ok(out.includes("share-link"));
    assert.ok(out.includes("--publish"));
    assert.ok(out.includes("--year <yyyy>"));
    assert.ok(out.includes("--month <1-12>"));
    assert.ok(out.includes("actions"));
    assert.ok(out.includes("action"));
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

  test("web 404 route redirects share path to query token", () => {
    const pages = [
      path.join(__dirname, "..", "docs", "404.html"),
      path.join(__dirname, "..", "public", "404.html"),
    ];
    for (const pagePath of pages) {
      assert.ok(fs.existsSync(pagePath), `${pagePath} is missing`);
      const raw = fs.readFileSync(pagePath, "utf8");
      assert.ok(
        raw.includes("/s/") || raw.includes("\\/s\\/"),
        `${pagePath} must inspect /s/:token path`
      );
      assert.ok(raw.includes("location.replace(\"/?share=\""), `${pagePath} must redirect token to query route`);
      assert.ok(raw.includes("location.replace(\"/\")"), `${pagePath} must fallback to root`);
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
      /^app\.use\(express\.json\(\{ limit: JSON_BODY_LIMIT \}\)\);/gm,
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
    assert.ok([200, 503].includes(sharesRes.status));
    if (sharesRes.status === 200) {
      assert.ok(
        upstreamCalls.some((call) => String(call.input).includes("/api/shares")),
        "share call should route through relay when configured"
      );
    }

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

  test("web adapter omits owner header for public share lookup", async () => {
    const ownerKey = "owner_key_abcdefghijklmnopqrstuvwxyz012345";
    const { sandbox, upstreamCalls } = createWebAdapterSandbox({
      shareBaseUrl: "https://relay.example.test",
      ownerKey,
    });
    const base = "https://example.test";
    const token = "share_token_abcdefghijklmnopqrstuvwxyz";
    const res = await sandbox.window.fetch(`${base}/api/shares/${token}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(upstreamCalls.length, 1);
    const call = upstreamCalls[0];
    assert.strictEqual(String(call.input), `https://relay.example.test/api/shares/${token}`);
    const headers = new Headers(call.init.headers || {});
    assert.strictEqual(headers.get("X-AJL-Share-Owner"), null);
  });

  test("web adapter forwards owner header for share management endpoints", async () => {
    const ownerKey = "owner_key_abcdefghijklmnopqrstuvwxyz012345";
    const { sandbox, upstreamCalls } = createWebAdapterSandbox({
      shareBaseUrl: "https://relay.example.test",
      ownerKey,
    });
    const base = "https://example.test";
    const res = await sandbox.window.fetch(`${base}/api/shares`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(upstreamCalls.length, 1);
    const call = upstreamCalls[0];
    assert.strictEqual(String(call.input), "https://relay.example.test/api/shares");
    const headers = new Headers(call.init.headers || {});
    assert.strictEqual(headers.get("X-AJL-Share-Owner"), ownerKey);
  });

  for (const t of tests) {
    const row = { name: t.name, status: "passed", error: null };
    try {
      await t.fn();
      passed += 1;
      log(`✔ ${t.name}`);
    } catch (err) {
      failed += 1;
      row.status = "failed";
      row.error = String(err?.stack || err?.message || err);
      fail(`✖ ${t.name}`);
      fail(`  ${err.message}`);
    }
    results.push(row);
  }

  const durationMs = Date.now() - start;
  const report = {
    profile: "janitor-functional",
    generated_at: new Date().toISOString(),
    summary: {
      total: tests.length,
      passed,
      failed,
      duration_ms: durationMs,
    },
    results,
  };
  const reportDir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "janitor-functional.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const duration = ((Date.now() - start) / 1000).toFixed(2);
  log(`\nJanitor complete: ${passed} passed, ${failed} failed (${duration}s)`);
  log(`Functional report: ${reportPath}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  fail(`Janitor crashed: ${err.message}`);
  process.exit(1);
});
