/* Janitor Property: invariant and replay checks for ledger safety */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function makeRng(seedInput) {
  let state = Number(seedInput) >>> 0;
  if (!Number.isFinite(state) || state === 0) state = 0xA13F00D;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function nowIso() {
  return new Date().toISOString();
}

async function run() {
  const seed = Number(process.env.AJL_PROPERTY_SEED || Date.now()) >>> 0;
  const rng = makeRng(seed);
  const startedAt = Date.now();
  const localApiKey = "janitor-property-key";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajl-janitor-property-"));
  process.env.AJL_DATA_DIR = tmpDir;
  process.env.AJL_DB_PATH = path.join(tmpDir, "ajl.sqlite");
  process.env.AJL_BACKUP_DIR = path.join(tmpDir, "backups");
  process.env.AJL_LOCK_FILE = path.join(tmpDir, "server.lock");
  process.env.AJL_DISABLE_LOCK = "1";
  process.env.AJL_LOCAL_API_KEY = localApiKey;
  process.env.AJL_MUTATION_RATE_PER_MIN = "100000";

  const reproPath = path.join(__dirname, "..", "reports", "janitor-repro.json");
  fs.mkdirSync(path.dirname(reproPath), { recursive: true });

  const { app, close } = require("../server");
  const server = await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";

  const trace = [];
  function recordTrace(entry) {
    trace.push({
      at: nowIso(),
      ...entry,
    });
    if (trace.length > 400) trace.shift();
  }

  async function request(method, urlPath, body) {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers["x-ajl-local-key"] = localApiKey;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const contentType = String(res.headers.get("content-type") || "");
    const data = contentType.includes("application/json")
      ? await res.json().catch(() => null)
      : await res.text().catch(() => "");
    recordTrace({
      method,
      urlPath,
      status: res.status,
      body: body === undefined ? null : body,
      data:
        typeof data === "string"
          ? data.slice(0, 200)
          : JSON.stringify(data || {}).slice(0, 400),
    });
    return { status: res.status, data };
  }

  async function failWithRepro(message, details = {}) {
    const payload = {
      profile: "janitor-property",
      seed,
      message,
      details,
      trace,
      generated_at: nowIso(),
    };
    fs.writeFileSync(reproPath, `${JSON.stringify(payload, null, 2)}\n`);
    throw new Error(message);
  }

  async function getInstances(year, month) {
    const res = await request("GET", `/api/instances?year=${year}&month=${month}`);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data));
    return res.data;
  }

  async function getSummary(year, month) {
    const res = await request("GET", `/api/v1/summary?year=${year}&month=${month}&essentials_only=false`);
    assert.strictEqual(res.status, 200);
    return res.data;
  }

  async function resetAndImport(backup) {
    const reset = await request("POST", "/api/reset-local", {});
    assert.strictEqual(reset.status, 200);
    const imported = await request("POST", "/api/import/backup", backup);
    assert.strictEqual(imported.status, 200);
  }

  function deriveTotals(instances) {
    return instances.reduce(
      (acc, item) => {
        if (item.status_derived === "skipped" || item.status === "skipped") return acc;
        const due = Number(item.amount || 0);
        const paid = Number(item.amount_paid || 0);
        acc.required += due;
        acc.paid += Math.min(due, paid);
        acc.remaining += Number(item.amount_remaining || 0);
        return acc;
      },
      { required: 0, paid: 0, remaining: 0 }
    );
  }

  async function assertSummaryInvariant(year, month) {
    const instances = await getInstances(year, month);
    const derived = deriveTotals(instances);
    if (instances.some((row) => Number(row.amount_remaining || 0) < -0.001)) {
      await failWithRepro("amount_remaining dropped below zero", { year, month });
    }
    const summary = await getSummary(year, month);
    const data = summary?.data || summary;
    const epsilon = 0.02;
    const same = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) <= epsilon;
    if (!same(data.required_month, derived.required)) {
      await failWithRepro("required_month invariant failed", { expected: derived.required, actual: data.required_month });
    }
    if (!same(data.paid_month, derived.paid)) {
      await failWithRepro("paid_month invariant failed", { expected: derived.paid, actual: data.paid_month });
    }
    if (!same(data.remaining_month, derived.remaining)) {
      await failWithRepro("remaining_month invariant failed", { expected: derived.remaining, actual: data.remaining_month });
    }
  }

  try {
    const year = 2026;
    const month = 3;

    for (let i = 0; i < 4; i += 1) {
      const create = await request("POST", `/api/templates?year=${year}&month=${month}`, {
        name: `Property ${i}`,
        category: "Property",
        amount_default: randInt(rng, 50, 500),
        due_day: randInt(rng, 1, 28),
        essential: true,
        active: true,
      });
      assert.strictEqual(create.status, 200);
    }
    await request("GET", `/api/ensure-month?year=${year}&month=${month}`);

    // Invariant: replaying same action ID should not mutate state twice.
    {
      const instances = await getInstances(year, month);
      const target = instances[0];
      assert.ok(target && target.id);
      const actionId = `property_replay_${seed}`;
      const payload = {
        action_id: actionId,
        type: "ADD_PAYMENT",
        instance_id: target.id,
        amount: 17.35,
        paid_date: "2026-03-03",
      };
      const before = await getInstances(year, month);
      const beforeTarget = before.find((row) => row.id === target.id);
      const beforePaid = Number(beforeTarget.amount_paid || 0);
      const first = await request("POST", "/api/v1/actions", payload);
      assert.strictEqual(first.status, 200);
      const second = await request("POST", "/api/v1/actions", payload);
      assert.ok([200, 409].includes(second.status));
      const after = await getInstances(year, month);
      const afterTarget = after.find((row) => row.id === target.id);
      const delta = Number(afterTarget.amount_paid || 0) - beforePaid;
      if (Math.abs(delta - 17.35) > 0.02) {
        await failWithRepro("idempotency invariant failed", { delta, beforePaid, afterPaid: afterTarget.amount_paid });
      }
    }

    // Invariant: same commutative updates on different instances should end with same totals regardless of order.
    {
      const firstSet = await getInstances(year, month);
      const a = firstSet[0];
      const b = firstSet[1];
      const payA = 11.11;
      const payB = 22.22;
      const snapshot = await request("GET", "/api/export/backup.json");
      assert.strictEqual(snapshot.status, 200);
      const backup = snapshot.data;

      const runSequence = async (orderTag) => {
        await resetAndImport(backup);
        const nonce = `${orderTag}_${Math.floor(rng() * 1e9)}`;
        const ops =
          orderTag === "ab"
            ? [
                { id: a.id, amount: payA },
                { id: b.id, amount: payB },
              ]
            : [
                { id: b.id, amount: payB },
                { id: a.id, amount: payA },
              ];
        for (const op of ops) {
          const action = await request("POST", "/api/v1/actions", {
            action_id: `order_${nonce}_${op.id}`,
            type: "ADD_PAYMENT",
            instance_id: op.id,
            amount: op.amount,
            paid_date: "2026-03-04",
          });
          assert.strictEqual(action.status, 200);
        }
        const summary = await getSummary(year, month);
        return summary.data || summary;
      };

      const ab = await runSequence("ab");
      const ba = await runSequence("ba");
      if (Math.abs(Number(ab.paid_month || 0) - Number(ba.paid_month || 0)) > 0.02) {
        await failWithRepro("ordering invariant failed", { ab, ba });
      }
    }

    // Property fuzz: random action sequences maintain totals and non-negative remaining.
    const fuzzCases = Number(process.env.AJL_PROPERTY_CASES || 1000);
    for (let i = 0; i < fuzzCases; i += 1) {
      const instances = await getInstances(year, month);
      const target = instances[randInt(rng, 0, instances.length - 1)];
      const op = randInt(rng, 1, 6);
      let action;
      if (op === 1) {
        action = {
          action_id: `fuzz_${seed}_${i}`,
          type: "MARK_PAID",
          instance_id: target.id,
          paid_date: "2026-03-06",
        };
      } else if (op === 2) {
        action = {
          action_id: `fuzz_${seed}_${i}`,
          type: "MARK_PENDING",
          instance_id: target.id,
        };
      } else if (op === 3) {
        action = {
          action_id: `fuzz_${seed}_${i}`,
          type: "SKIP_INSTANCE",
          instance_id: target.id,
        };
      } else if (op === 4) {
        action = {
          action_id: `fuzz_${seed}_${i}`,
          type: "ADD_PAYMENT",
          instance_id: target.id,
          amount: Number((rng() * 80 + 1).toFixed(2)),
          paid_date: "2026-03-07",
        };
      } else if (op === 5) {
        action = {
          action_id: `fuzz_${seed}_${i}`,
          type: "UPDATE_INSTANCE_FIELDS",
          instance_id: target.id,
          amount: Number((rng() * 700).toFixed(2)),
        };
      } else {
        action = {
          action_id: `fuzz_${seed}_${i}`,
          type: "UPDATE_INSTANCE_FIELDS",
          instance_id: target.id,
          note: `note-${i}`,
        };
      }
      const res = await request("POST", "/api/v1/actions", action);
      if (![200, 400, 409].includes(res.status)) {
        await failWithRepro("unexpected fuzz action status", { status: res.status, action });
      }
      await assertSummaryInvariant(year, month);
    }

    // Replay invariant under concurrency.
    {
      const instances = await getInstances(year, month);
      const target = instances[2];
      const actionId = `concurrency_${seed}`;
      const payload = {
        action_id: actionId,
        type: "ADD_PAYMENT",
        instance_id: target.id,
        amount: 9.99,
        paid_date: "2026-03-08",
      };
      const before = await getInstances(year, month);
      const beforePaid = Number(before.find((row) => row.id === target.id).amount_paid || 0);
      const calls = Array.from({ length: 16 }).map(() => request("POST", "/api/v1/actions", payload));
      const resList = await Promise.all(calls);
      if (resList.some((row) => ![200, 409].includes(row.status))) {
        await failWithRepro("unexpected status in concurrency replay", {
          statuses: resList.map((row) => row.status),
        });
      }
      const after = await getInstances(year, month);
      const afterPaid = Number(after.find((row) => row.id === target.id).amount_paid || 0);
      const delta = afterPaid - beforePaid;
      if (Math.abs(delta - 9.99) > 0.02) {
        await failWithRepro("concurrency replay invariant failed", { beforePaid, afterPaid, delta });
      }
    }

    await assertSummaryInvariant(year, month);

    const durationMs = Date.now() - startedAt;
    const report = {
      profile: "janitor-property",
      generated_at: nowIso(),
      seed,
      summary: {
        total: 4,
        passed: 4,
        failed: 0,
        duration_ms: durationMs,
        by_severity: {
          HIGH: 4,
        },
      },
      results: [
        {
          id: "property_idempotency_replay",
          title: "idempotency invariant holds under replay",
          name: "idempotency invariant holds under replay",
          severity: "HIGH",
          attack: "Replay same action id",
          expected: "Second replay should not mutate ledger.",
          status: "passed",
          actual: "passed",
          error: null,
          request: null,
          response_meta: null,
          repro_curl: "",
          seed,
        },
        {
          id: "property_ordering_commutative",
          title: "commutative ordering invariant holds",
          name: "commutative ordering invariant holds",
          severity: "HIGH",
          attack: "Reorder independent updates",
          expected: "Final totals match regardless of order.",
          status: "passed",
          actual: "passed",
          error: null,
          request: null,
          response_meta: null,
          repro_curl: "",
          seed,
        },
        {
          id: "property_fuzz_invariants",
          title: "fuzz invariants hold across randomized actions",
          name: "fuzz invariants hold across randomized actions",
          severity: "HIGH",
          attack: `Random action fuzz (${fuzzCases} cases)`,
          expected: "No negative remaining and summary invariants always hold.",
          status: "passed",
          actual: `${fuzzCases} cases passed`,
          error: null,
          request: null,
          response_meta: null,
          repro_curl: "",
          seed,
        },
        {
          id: "property_concurrency_replay",
          title: "concurrency replay invariant holds",
          name: "concurrency replay invariant holds",
          severity: "HIGH",
          attack: "Concurrent identical mutation replay",
          expected: "Only one mutation should apply.",
          status: "passed",
          actual: "passed",
          error: null,
          request: null,
          response_meta: null,
          repro_curl: "",
          seed,
        },
      ],
    };
    const reportPath = path.join(__dirname, "..", "reports", "janitor-property.json");
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Janitor property complete: passed (seed ${seed})\n`);
    process.stdout.write(`Property report: ${reportPath}\n`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  try {
    const reportPath = path.join(__dirname, "..", "reports", "janitor-property.json");
    const report = {
      profile: "janitor-property",
      generated_at: nowIso(),
      seed: Number(process.env.AJL_PROPERTY_SEED || 0) || null,
      summary: {
        total: 1,
        passed: 0,
        failed: 1,
        duration_ms: 0,
        by_severity: {
          HIGH: 1,
        },
      },
      results: [
        {
          id: "property_suite_execution",
          title: "property suite execution",
          name: "property suite execution",
          severity: "HIGH",
          attack: "run property test suite",
          expected: "Suite completes with all invariants passing.",
          status: "failed",
          actual: String(err?.message || err),
          error: String(err?.stack || err),
          request: null,
          response_meta: null,
          repro_curl: "",
        },
      ],
    };
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (writeErr) {
    // ignore secondary report write error
  }
  process.stderr.write(`${String(err?.stack || err)}\n`);
  process.exit(1);
});
