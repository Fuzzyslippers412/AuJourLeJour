/* Janitor: automated QA suite for Au Jour Le Jour */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
    if (setCookie) {
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
  });

  test("settings defaults load", async () => {
    const res = await request("GET", "/api/settings");
    assert.strictEqual(res.status, 200, `settings status ${res.status}`);
    assert.strictEqual(res.data.hasCompletedOnboarding, false);
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

  test("share link lifecycle", async () => {
    const shareRes = await request("POST", "/api/shares", {
      mode: "live",
      owner_label: "Test",
    });
    assert.strictEqual(shareRes.status, 200);
    shareToken = shareRes.data.shareToken;
    assert.ok(shareToken);

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
