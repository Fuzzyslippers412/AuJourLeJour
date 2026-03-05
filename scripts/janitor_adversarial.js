/* Janitor Adversarial: security-focused QA profile ("Shannon mode") */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

function log(line) {
  process.stdout.write(`${line}\n`);
}

function fail(line) {
  process.stderr.write(`${line}\n`);
}

function makeTemplatePayload(name, amount = 100, dueDay = 5) {
  return {
    name,
    category: "Janitor",
    amount_default: amount,
    due_day: dueDay,
    autopay: false,
    essential: true,
    active: true,
    default_note: null,
    match_payee_key: null,
    match_amount_tolerance: 5,
  };
}

function createSharePayload(label = "Shared Item") {
  return {
    schema_version: "1",
    period: "2026-03",
    owner_label: "Janitor",
    generated_at: new Date().toISOString(),
    privacy: {
      include_amounts: true,
      include_notes: true,
      include_categories: true,
    },
    items: [
      {
        id: "share_item_1",
        template_id: "share_template_1",
        year: 2026,
        month: 3,
        name_snapshot: label,
        category_snapshot: "Utilities",
        amount: 120,
        due_date: "2026-03-01",
        status: "pending",
        paid_date: null,
        amount_paid: 0,
        amount_remaining: 120,
        essential_snapshot: true,
        autopay_snapshot: false,
        note: null,
      },
    ],
    categories: ["Utilities"],
  };
}

function redactHeaders(headers) {
  const out = {};
  Object.entries(headers || {}).forEach(([key, value]) => {
    if (/authorization|x-ajl-local-key|x-ajl-share-owner|cookie/i.test(key)) {
      out[key] = "[REDACTED]";
      return;
    }
    out[key] = value;
  });
  return out;
}

function redactPreview(value, secrets = []) {
  let out = String(value || "");
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(String(secret)).join("[REDACTED]");
  }
  out = out.replace(/authorization:\s*[^\n\r]+/gi, "authorization: [REDACTED]");
  out = out.replace(/"ownerKey"\s*:\s*"[^"]*"/gi, "\"ownerKey\":\"[REDACTED]\"");
  out = out.replace(/"manageKey"\s*:\s*"[^"]*"/gi, "\"manageKey\":\"[REDACTED]\"");
  return out;
}

function redactResponseHeaders(headers = {}, secrets = []) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/set-cookie|authorization|x-ajl-share-owner|x-ajl-local-key/i.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = redactPreview(value, secrets);
  }
  return out;
}

function buildReproCurl(base, trace) {
  if (!trace) return "";
  const headers = trace.headers || {};
  const headerArgs = Object.entries(headers)
    .map(([key, value]) => `-H ${JSON.stringify(`${key}: ${String(value)}`)}`)
    .join(" ");
  const bodyArg =
    trace.body === undefined || trace.body === null
      ? ""
      : ` --data ${JSON.stringify(typeof trace.body === "string" ? trace.body : JSON.stringify(trace.body))}`;
  return `curl -i -X ${trace.method || "GET"} ${headerArgs}${bodyArg} ${JSON.stringify(`${base}${trace.urlPath || ""}`)}`.trim();
}

async function run() {
  const startedAt = Date.now();
  const tests = [];
  const results = [];

  function test(name, severity, fn, meta = {}) {
    tests.push({ name, severity, fn, ...meta });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajl-janitor-adversarial-"));
  const localApiKey = "janitor-local-key";
  process.env.AJL_DATA_DIR = tmpDir;
  process.env.AJL_DB_PATH = path.join(tmpDir, "ajl.sqlite");
  process.env.AJL_BACKUP_DIR = path.join(tmpDir, "backups");
  process.env.AJL_LOCK_FILE = path.join(tmpDir, "server.lock");
  process.env.AJL_DISABLE_LOCK = "1";
  process.env.AJL_LOCAL_API_KEY = localApiKey;
  process.env.AJL_MUTATION_RATE_PER_MIN = "80";
  process.env.AJL_MUTATION_RATE_WINDOW_MS = "5000";
  process.env.AJL_SHARE_LOOKUP_RATE_LIMIT = "40";
  process.env.AJL_SHARE_LOOKUP_IP_RATE_LIMIT = "45";
  process.env.AJL_SHARE_LOOKUP_WINDOW_MS = "5000";
  process.env.AJL_TRUST_PROXY = "0";
  process.env.AJL_JSON_BODY_LIMIT = "256kb";
  process.env.PUBLIC_BASE_URL = "http://127.0.0.1";

  const { app, close } = require("../server");
  const server = await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  let lastTrace = null;

  function isMutation(method, urlPath) {
    const verb = String(method || "GET").toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(verb)) return false;
    return urlPath.startsWith("/api/") || urlPath.startsWith("/internal/");
  }

  async function request(method, urlPath, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    const useCookie = options.useCookie !== false;
    const useApiKey = options.useApiKey !== false;
    if (useCookie && cookie) {
      headers.cookie = cookie;
    }
    if (isMutation(method, urlPath) && useApiKey && !headers["x-ajl-local-key"]) {
      headers["x-ajl-local-key"] = localApiKey;
    }
    let body;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      const hasContentType = Object.keys(headers).some(
        (key) => String(key).toLowerCase() === "content-type"
      );
      if (options.rawContentType !== undefined) {
        if (options.rawContentType && !hasContentType) {
          headers["Content-Type"] = options.rawContentType;
        }
      } else if (!hasContentType) {
        headers["Content-Type"] = "application/json";
      }
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    }
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers,
      body,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie && useCookie) {
      cookie = setCookie.split(";")[0];
    }
    const contentType = String(res.headers.get("content-type") || "");
    let data;
    if (contentType.includes("application/json")) {
      data = await res.json().catch(() => null);
    } else {
      data = await res.text().catch(() => "");
    }
    const rawResponseHeaders = {};
    res.headers.forEach((value, key) => {
      rawResponseHeaders[key] = value;
    });
    const responseHeaders = redactResponseHeaders(rawResponseHeaders, [localApiKey, ownerKey]);
    lastTrace = {
      method,
      urlPath,
      headers: redactHeaders(headers),
      body: options.rawBody !== undefined ? options.rawBody : options.body,
      status: res.status,
      response_headers: responseHeaders,
      response_preview: redactPreview(
        typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data || {}).slice(0, 500),
        [localApiKey, ownerKey]
      ),
    };
    return { status: res.status, data, headers: res.headers };
  }

  async function requestWith429Retry(method, urlPath, options = {}, maxAttempts = 3) {
    let attempt = 0;
    let last = null;
    while (attempt < maxAttempts) {
      // eslint-disable-next-line no-await-in-loop
      last = await request(method, urlPath, options);
      if (last.status !== 429) return last;
      const retryAfter = Number(last.headers.get("retry-after") || 1);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
      attempt += 1;
    }
    return last;
  }

  async function rawHttp(payload, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const timer = setTimeout(() => {
        socket.destroy(new Error("raw socket timeout"));
      }, timeoutMs);
      let data = "";
      socket.on("connect", () => {
        socket.write(payload);
      });
      socket.on("data", (chunk) => {
        data += String(chunk || "");
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.on("end", () => {
        clearTimeout(timer);
        const statusMatch = data.match(/^HTTP\/1\.[01]\s+(\d{3})/m);
        const status = statusMatch ? Number(statusMatch[1]) : 0;
        resolve({ status, raw: data });
      });
    });
  }

  let shareToken = null;
  let regeneratedShareToken = null;
  let ownerKey = null;
  let rngState = 0xC0FFEE;

  function rand() {
    // Deterministic LCG for reproducible fuzz payloads.
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0x100000000;
  }

  test("security headers are present on API responses", "HIGH", async () => {
    const res = await request("GET", "/api/health", { useCookie: false, useApiKey: false });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("x-content-type-options"), "nosniff");
    assert.strictEqual(res.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.strictEqual(res.headers.get("referrer-policy"), "no-referrer");
  });

  test("local API key is required for mutations", "BLOCKER", async () => {
    const withoutKey = await request("POST", "/api/templates", {
      body: makeTemplatePayload("NoKey"),
      useApiKey: false,
    });
    assert.strictEqual(withoutKey.status, 401);

    const wrongKey = await request("POST", "/api/templates", {
      body: makeTemplatePayload("BadKey"),
      useApiKey: false,
      headers: { "x-ajl-local-key": "invalid-key" },
    });
    assert.strictEqual(wrongKey.status, 401);

    const withKey = await request("POST", "/api/templates", { body: {} });
    assert.notStrictEqual(withKey.status, 401);
  });

  test("owner share endpoints reject unauthenticated calls", "BLOCKER", async () => {
    await request("GET", "/api/health");
    const create = await request("POST", "/api/shares", { body: { mode: "live" } });
    assert.strictEqual(create.status, 200);
    assert.ok(create.data.shareToken);
    shareToken = create.data.shareToken;
    ownerKey = String(create.data.ownerKey || "");
    assert.ok(ownerKey.length >= 24);

    const ownerReadNoCookie = await request("GET", "/api/shares", {
      useCookie: false,
      useApiKey: false,
    });
    assert.strictEqual(ownerReadNoCookie.status, 401);

    const patchNoCookie = await request("PATCH", `/api/shares/${shareToken}`, {
      body: { mode: "snapshot" },
      useCookie: false,
    });
    assert.strictEqual(patchNoCookie.status, 401);

    const publishNoCookie = await request("POST", `/api/shares/${shareToken}/publish`, {
      body: { payload: createSharePayload(), schema_version: "1" },
      useCookie: false,
    });
    assert.strictEqual(publishNoCookie.status, 401);

    const publishCurrentNoCookie = await request(
      "POST",
      `/api/shares/${shareToken}/publish-current`,
      {
        body: { year: 2026, month: 3 },
        useCookie: false,
      }
    );
    assert.strictEqual(publishCurrentNoCookie.status, 401);
  });

  test("owner key header works only with valid key", "HIGH", async () => {
    const bad = await request("GET", "/api/shares", {
      useCookie: false,
      useApiKey: false,
      headers: { "X-AJL-Share-Owner": "bad-key" },
    });
    assert.strictEqual(bad.status, 401);

    const good = await request("GET", "/api/shares", {
      useCookie: false,
      useApiKey: false,
      headers: { "X-AJL-Share-Owner": ownerKey },
    });
    assert.strictEqual(good.status, 200);
    assert.ok(good.data && typeof good.data === "object");
  });

  test("public share lookup is read-only and does not expose owner credentials", "BLOCKER", async () => {
    const publish = await request("POST", `/api/shares/${shareToken}/publish`, {
      body: { payload: createSharePayload("Public view item"), schema_version: "1" },
    });
    assert.strictEqual(publish.status, 200);

    const publicRes = await request("GET", `/api/shares/${shareToken}`, {
      useCookie: false,
      useApiKey: false,
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    assert.strictEqual(publicRes.status, 200);
    assert.ok(publicRes.data && publicRes.data.payload);
    assert.strictEqual(publicRes.data.ownerKey, undefined);
    assert.strictEqual(publicRes.data.manageKey, undefined);
    assert.strictEqual(publicRes.headers.get("set-cookie"), null);
  });

  test("share token regeneration and disable invalidate old links", "HIGH", async () => {
    const regen = await request("POST", `/api/shares/${shareToken}/regenerate`, { body: {} });
    assert.strictEqual(regen.status, 200);
    assert.ok(regen.data.shareToken && regen.data.shareToken !== shareToken);
    regeneratedShareToken = regen.data.shareToken;

    const oldToken = await request("GET", `/api/shares/${shareToken}`, {
      useCookie: false,
      useApiKey: false,
      headers: { "x-forwarded-for": "198.51.100.11" },
    });
    assert.ok(oldToken.status === 404 || oldToken.status === 410);

    const disable = await request("PATCH", `/api/shares/${regeneratedShareToken}`, {
      body: { isActive: false },
    });
    assert.strictEqual(disable.status, 200);

    const disabledLookup = await request("GET", `/api/shares/${regeneratedShareToken}`, {
      useCookie: false,
      useApiKey: false,
      headers: { "x-forwarded-for": "198.51.100.12" },
    });
    assert.strictEqual(disabledLookup.status, 410);

    // Restore a fresh active share token for downstream tests.
    const fresh = await request("POST", "/api/shares", { body: { mode: "live" } });
    assert.strictEqual(fresh.status, 200);
    shareToken = fresh.data.shareToken;
    ownerKey = String(fresh.data.ownerKey || ownerKey || "");
    const publishFresh = await request("POST", `/api/shares/${shareToken}/publish`, {
      body: { payload: createSharePayload("fresh-live-share"), schema_version: "1" },
    });
    assert.strictEqual(publishFresh.status, 200);
  });

  test("share publish rejects oversized payloads", "HIGH", async () => {
    const create = await request("POST", "/api/shares", { body: { mode: "live" } });
    assert.strictEqual(create.status, 200);
    const token = create.data.shareToken;
    const huge = "A".repeat(2_200_000);
    const payload = createSharePayload(huge);
    const res = await request("POST", `/api/shares/${token}/publish`, {
      body: { payload, schema_version: "1" },
    });
    assert.ok([400, 413].includes(res.status), `expected 400/413, got ${res.status}`);
  });

  test("share publish validates payload schema fields", "HIGH", async () => {
    const create = await request("POST", "/api/shares", { body: { mode: "live" } });
    assert.strictEqual(create.status, 200);
    const token = create.data.shareToken;
    const badPayload = createSharePayload();
    badPayload.items[0].status = "owned";
    const res = await request("POST", `/api/shares/${token}/publish`, {
      body: { payload: badPayload, schema_version: "1" },
    });
    assert.strictEqual(res.status, 400);
  });

  test("publish-current rejects invalid year/month", "HIGH", async () => {
    const create = await request("POST", "/api/shares", { body: { mode: "live" } });
    assert.strictEqual(create.status, 200);
    const token = create.data.shareToken;
    const bad = await request("POST", `/api/shares/${token}/publish-current`, {
      body: { year: 1999, month: 13 },
    });
    assert.strictEqual(bad.status, 400);
  });

  test("SQLi-style template names do not break table integrity", "HIGH", async () => {
    const sqliName = "Rent'); DROP TABLE templates; --";
    const res1 = await request("POST", "/api/templates?year=2026&month=3", {
      body: makeTemplatePayload(sqliName, 100, 5),
    });
    assert.strictEqual(res1.status, 200);

    const res2 = await request("POST", "/api/templates?year=2026&month=3", {
      body: makeTemplatePayload("Safety Template", 130, 6),
    });
    assert.strictEqual(res2.status, 200);

    const list = await request("GET", "/api/templates");
    assert.strictEqual(list.status, 200);
    const names = Array.isArray(list.data) ? list.data.map((row) => row.name) : [];
    assert.ok(names.includes(sqliName));
    assert.ok(names.includes("Safety Template"));
  });

  test("XSS-style note payload is treated as plain data", "HIGH", async () => {
    await request("GET", "/api/ensure-month?year=2026&month=3");
    const list = await request("GET", "/api/instances?year=2026&month=3");
    assert.strictEqual(list.status, 200);
    const target = Array.isArray(list.data)
      ? list.data.find((row) => row.name_snapshot === "Safety Template")
      : null;
    assert.ok(target && target.id);
    const xss = "<img src=x onerror=alert('xss')>";
    const patch = await request("PATCH", `/api/instances/${target.id}`, {
      body: { note: xss },
    });
    assert.strictEqual(patch.status, 200);
    const list2 = await request("GET", "/api/instances?year=2026&month=3");
    assert.strictEqual(list2.status, 200);
    const updated = list2.data.find((row) => row.id === target.id);
    assert.strictEqual(updated.note, xss);
    assert.ok(String(list2.headers.get("content-type") || "").includes("application/json"));
  });

  test("duplicate action replay cannot double-apply payment", "BLOCKER", async () => {
    const create = await request("POST", "/api/templates?year=2026&month=3", {
      body: makeTemplatePayload("Replay Target", 100, 8),
    });
    assert.strictEqual(create.status, 200);
    await request("GET", "/api/ensure-month?year=2026&month=3");
    const list = await request("GET", "/api/instances?year=2026&month=3");
    const target = list.data.find((row) => row.name_snapshot === "Replay Target");
    assert.ok(target && target.id);
    const actionId = `adv_replay_${Date.now()}`;
    const body = {
      action_id: actionId,
      type: "ADD_PAYMENT",
      instance_id: target.id,
      amount: 10,
      paid_date: "2026-03-08",
    };
    const [a, b] = await Promise.all([
      request("POST", "/api/v1/actions", { body }),
      request("POST", "/api/v1/actions", { body }),
    ]);
    assert.ok([200, 409].includes(a.status), `unexpected status A: ${a.status}`);
    assert.ok([200, 409].includes(b.status), `unexpected status B: ${b.status}`);

    const after = await request("GET", "/api/instances?year=2026&month=3");
    const updated = after.data.find((row) => row.id === target.id);
    assert.ok(updated);
    assert.ok(Number(updated.amount_paid) <= 10.01, `amount_paid too high: ${updated.amount_paid}`);
  });

  test("invalid JSON body returns sanitized 400 (no stack trace leakage)", "BLOCKER", async () => {
    const res = await request("POST", "/api/templates", {
      rawBody: "{\"name\":",
      rawContentType: "application/json",
    });
    assert.strictEqual(res.status, 400);
    const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data || {});
    assert.ok(!/SyntaxError|at\s+\w+\s*\(|stack/i.test(text), "response leaked parser stack");
  });

  test("malformed cookie header does not crash request handling", "HIGH", async () => {
    const res = await request("GET", "/api/health", {
      useCookie: false,
      useApiKey: false,
      headers: { Cookie: "ajl_owner=%E0%A4%A; x=y" },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data?.ok, true);
  });

  test("path-traversal-style share token input is rejected", "HIGH", async () => {
    const res = await request("GET", "/api/shares/%2e%2e%2fetc%2fpasswd", {
      useCookie: false,
      useApiKey: false,
      headers: { "x-forwarded-for": "198.51.100.13" },
    });
    assert.strictEqual(res.status, 400);
  });

  test("share token probing is rate-limited", "HIGH", async () => {
    let sawRateLimit = false;
    for (let i = 0; i < 85; i += 1) {
      const token = `missing_share_token_${String(i).padStart(2, "0")}__ABCDEFGHijklmnop`;
      const res = await request("GET", `/api/shares/${token}`, {
        useCookie: false,
        useApiKey: false,
        headers: { "x-forwarded-for": "198.51.100.77" },
      });
      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after") || 0);
        assert.ok(retry >= 1, "share lookup 429 missing Retry-After");
        sawRateLimit = true;
        break;
      }
      assert.ok([400, 404, 410].includes(res.status), `unexpected status ${res.status}`);
    }
    assert.strictEqual(sawRateLimit, true, "expected token probing to hit rate limit");
  });

  test("mutation flood is rate-limited", "HIGH", async () => {
    let sawRateLimit = false;
    for (let i = 0; i < 160; i += 1) {
      const res = await request("POST", "/api/chat", {
        body: { role: "user", text: `flood-${i}` },
      });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
      assert.ok([200, 400].includes(res.status), `unexpected status ${res.status}`);
    }
    assert.strictEqual(sawRateLimit, true, "expected mutation flood to hit rate limit");
  });

  test("diagnostics do not leak local API key value", "HIGH", async () => {
    const res = await request("GET", "/api/system/diagnostics");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data?.limits?.local_api_key_enabled, true);
    const blob = JSON.stringify(res.data || {});
    assert.ok(!blob.includes(localApiKey), "diagnostics leaked local api key value");
  });

  test("fuzzed action payloads never return 500", "HIGH", async () => {
    const actionTypes = [
      "MARK_PAID",
      "MARK_PENDING",
      "SKIP_INSTANCE",
      "ADD_PAYMENT",
      "UPDATE_INSTANCE_FIELDS",
      "CREATE_TEMPLATE",
      "UPDATE_TEMPLATE",
      "ARCHIVE_TEMPLATE",
      "DELETE_TEMPLATE",
      "GENERATE_MONTH",
      "UNKNOWN_TYPE",
      "",
    ];
    const weirdValues = [
      null,
      "",
      "x",
      "2026-13-40",
      "__proto__",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      0,
      1,
      999999999999,
      true,
      false,
      {},
      [],
    ];
    for (let i = 0; i < 80; i += 1) {
      const pick = (arr) => arr[Math.floor(rand() * arr.length)];
      const payload = {
        action_id: `adv_fuzz_${i}_${Math.floor(rand() * 1e9)}`,
        type: pick(actionTypes),
        instance_id: pick(weirdValues),
        template_id: pick(weirdValues),
        amount: pick(weirdValues),
        due_date: pick(weirdValues),
        year: pick(weirdValues),
        month: pick(weirdValues),
        note: pick(weirdValues),
      };
      // eslint-disable-next-line no-await-in-loop
      const res = await request("POST", "/api/v1/actions", { body: payload });
      assert.notStrictEqual(res.status, 500, `fuzz case ${i} returned 500`);
    }
  });

  test("IDOR sweep rejects guessed resource identifiers", "HIGH", async () => {
    const guesses = [
      "/api/instances/not-a-real-id",
      "/api/templates/not-a-real-id",
      "/api/v1/actions/not-a-real-id",
      "/api/shares/not-a-real-token",
    ];
    for (const route of guesses) {
      // eslint-disable-next-line no-await-in-loop
      const res = await requestWith429Retry("GET", route, { useApiKey: false });
      assert.notStrictEqual(res.status, 500);
      assert.ok([400, 401, 404, 410].includes(res.status));
    }
  });

  test("share token cannot mutate owner endpoints (least privilege)", "BLOCKER", async () => {
    const fresh = await request("POST", "/api/shares", { body: { mode: "live" } });
    assert.strictEqual(fresh.status, 200);
    const token = fresh.data.shareToken;
    const publish = await request("POST", `/api/shares/${token}/publish`, {
      body: { payload: createSharePayload("least-privilege"), schema_version: "1" },
    });
    assert.strictEqual(publish.status, 200);
    const publicRead = await requestWith429Retry("GET", `/api/shares/${token}`, {
      useApiKey: false,
      useCookie: false,
    });
    assert.strictEqual(publicRead.status, 200);
    const mutate = await request("PATCH", `/api/shares/${token}`, {
      useApiKey: false,
      useCookie: false,
      body: { mode: "snapshot" },
      headers: { "x-ajl-share-token": token },
    });
    assert.strictEqual(mutate.status, 401);
  });

  test("auth header confusion is rejected deterministically", "HIGH", async () => {
    const commaHeader = await request("GET", "/api/shares", {
      useCookie: false,
      useApiKey: false,
      headers: { "x-ajl-share-owner": `${ownerKey},bad` },
    });
    assert.strictEqual(commaHeader.status, 401);

    const whitespaceHeader = await request("GET", "/api/shares", {
      useCookie: false,
      useApiKey: false,
      headers: { "X-AJL-SHARE-OWNER": ` ${ownerKey} ` },
    });
    assert.strictEqual(whitespaceHeader.status, 200);
  });

  test("HTTP method override headers are blocked", "HIGH", async () => {
    const res = await request("POST", "/api/templates", {
      body: makeTemplatePayload("Override Attempt"),
      headers: { "X-HTTP-Method-Override": "DELETE" },
    });
    assert.strictEqual(res.status, 400);
  });

  test("content-type confusion is rejected", "HIGH", async () => {
    const text = await request("POST", "/api/templates", {
      rawBody: JSON.stringify(makeTemplatePayload("ct-text")),
      rawContentType: "text/plain",
    });
    assert.strictEqual(text.status, 415);

    const form = await request("POST", "/api/templates", {
      rawBody: "name=form&amount=10",
      rawContentType: "application/x-www-form-urlencoded",
    });
    assert.strictEqual(form.status, 415);

    const missing = await request("POST", "/api/templates", {
      rawBody: JSON.stringify(makeTemplatePayload("ct-missing")),
      rawContentType: null,
      headers: {},
    });
    assert.strictEqual(missing.status, 415);
  });

  test("body bombs are rejected without 500", "HIGH", async () => {
    const deep = {};
    let cursor = deep;
    for (let i = 0; i < 600; i += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    const largePayload = {
      type: "UPDATE_INSTANCE_FIELDS",
      action_id: `bomb_${Date.now()}`,
      instance_id: "none",
      note: "x".repeat(300_000),
      deep,
    };
    const res = await request("POST", "/api/v1/actions", { body: largePayload });
    assert.notStrictEqual(res.status, 500);
    assert.ok([400, 413].includes(res.status), `expected 400/413, got ${res.status}`);
  });

  test("conflicting CL/TE headers are rejected", "HIGH", async () => {
    const raw = [
      "POST /api/templates HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Content-Type: application/json",
      "Content-Length: 18",
      "Transfer-Encoding: chunked",
      "",
      "{\"name\":\"clte\"}",
    ].join("\r\n");
    const res = await rawHttp(raw);
    assert.ok([400, 413].includes(res.status), `unexpected status ${res.status}`);
  });

  test("prototype pollution payloads do not alter object prototype", "HIGH", async () => {
    const before = {}.polluted;
    const res = await request("POST", "/api/templates", {
      body: {
        __proto__: { polluted: "yes" },
        name: "Proto Pollution",
        category: "Janitor",
        amount_default: 50,
        due_day: 5,
        essential: true,
        active: true,
      },
    });
    assert.notStrictEqual(res.status, 500);
    assert.strictEqual({}.polluted, before);
  });

  test("unicode and encoded token variants are rejected cleanly", "HIGH", async () => {
    const cases = [
      "/api/shares/%EF%BC%A1%EF%BC%A2%EF%BC%A3",
      "/api/shares/%252Fetc%252Fpasswd",
      "/api/shares/%2Fetc%2Fpasswd",
    ];
    for (const route of cases) {
      // eslint-disable-next-line no-await-in-loop
      const res = await requestWith429Retry("GET", route, {
        useApiKey: false,
        useCookie: false,
      });
      assert.notStrictEqual(res.status, 500);
      assert.ok([400, 404].includes(res.status), `unexpected status ${res.status}`);
    }
  });

  test("credentialed share endpoints do not expose wildcard CORS", "HIGH", async () => {
    const fresh = await request("POST", "/api/shares", { body: { mode: "live" } });
    assert.strictEqual(fresh.status, 200);
    const token = fresh.data.shareToken;
    const published = await request("POST", `/api/shares/${token}/publish`, {
      body: { payload: createSharePayload("cors-check"), schema_version: "1" },
    });
    assert.strictEqual(published.status, 200);
    const res = await requestWith429Retry("GET", `/api/shares/${token}`, {
      useApiKey: false,
      useCookie: false,
      headers: { Origin: "https://evil.example" },
    });
    assert.strictEqual(res.status, 200);
    const allow = res.headers.get("access-control-allow-origin");
    assert.ok(allow === null || allow === "", "credentialed share endpoint must not emit wildcard CORS");
  });

  test("CSRF posture blocks cross-site share mutations", "HIGH", async () => {
    const fresh = await request("POST", "/api/shares", { body: { mode: "live" } });
    assert.strictEqual(fresh.status, 200);
    const token = fresh.data.shareToken;
    const crossSite = await request("PATCH", `/api/shares/${token}`, {
      body: { mode: "snapshot" },
      headers: { Origin: "https://evil.example" },
    });
    assert.strictEqual(crossSite.status, 403);
  });

  test("UI routes include CSP and block inline script by default", "HIGH", async () => {
    const res = await request("GET", "/", { useApiKey: false });
    assert.strictEqual(res.status, 200);
    const csp = String(res.headers.get("content-security-policy") || "").toLowerCase();
    assert.ok(csp.includes("script-src 'self'"), "CSP must pin script-src to self");
    assert.ok(!csp.includes("'unsafe-inline'"), "CSP must not allow unsafe-inline scripts");
  });

  test("error responses are redacted (no stack, file path, SQL leak)", "HIGH", async () => {
    const res = await request("POST", "/api/templates", {
      rawBody: "{\"name\":",
      rawContentType: "application/json",
    });
    const blob = typeof res.data === "string" ? res.data : JSON.stringify(res.data || {});
    assert.ok(!/\/users\/|\\.js:\\d+|syntaxerror|select\\s+/i.test(blob), "error response leaked internals");
  });

  test("logs and traces are redacted for key material", "HIGH", async () => {
    const haystack = JSON.stringify({ results, lastTrace });
    assert.ok(!/authorization:/i.test(haystack));
    assert.ok(!haystack.includes(localApiKey), "local API key leaked into traces");
    if (ownerKey) {
      assert.ok(!haystack.includes(ownerKey), "owner key leaked into traces");
    }
  });

  test("rate limiting returns Retry-After and recovers after window", "HIGH", async () => {
    // Mutation limit window is configured by env in this test harness.
    let limited = null;
    for (let i = 0; i < 160; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request("POST", "/api/chat", { body: { role: "user", text: `limit-${i}` } });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    assert.ok(limited, "expected to hit mutation rate limit");
    const retryAfter = Number(limited.headers.get("retry-after") || 0);
    assert.ok(retryAfter >= 1, "missing retry-after header");
    await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
    const recovered = await request("POST", "/api/chat", { body: { role: "user", text: "limit-recovery" } });
    assert.notStrictEqual(recovered.status, 429, "rate limit did not recover after window");
  });

  test("x-forwarded-for spoofing does not bypass limits when proxy trust is off", "HIGH", async () => {
    let saw429 = false;
    for (let i = 0; i < 160; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request("POST", "/api/chat", {
        body: { role: "user", text: `spoof-${i}` },
        headers: { "x-forwarded-for": `203.0.113.${i % 255}` },
      });
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    assert.strictEqual(saw429, true, "x-forwarded-for spoofing bypassed rate limit");
  });

  test("parallel mutation storm preserves idempotent balance invariants", "BLOCKER", async () => {
    const create = await request("POST", "/api/templates?year=2026&month=4", {
      body: makeTemplatePayload("Storm Target", 300, 9),
    });
    assert.strictEqual(create.status, 200);
    await request("GET", "/api/ensure-month?year=2026&month=4");
    const list = await request("GET", "/api/instances?year=2026&month=4");
    const target = list.data.find((row) => row.name_snapshot === "Storm Target");
    assert.ok(target && target.id);
    const actionId = `storm_${Date.now()}`;
    const payload = {
      action_id: actionId,
      type: "ADD_PAYMENT",
      instance_id: target.id,
      amount: 77,
      paid_date: "2026-04-09",
    };
    const calls = Array.from({ length: 25 }).map(() => request("POST", "/api/v1/actions", { body: payload }));
    const responses = await Promise.all(calls);
    assert.ok(responses.every((r) => [200, 409].includes(r.status)));
    const after = await request("GET", "/api/instances?year=2026&month=4");
    const updated = after.data.find((row) => row.id === target.id);
    assert.ok(Math.abs(Number(updated.amount_paid || 0) - 77) <= 0.05);
  });

  test("security route registry exists and all routes have security metadata", "BLOCKER", async () => {
    const res = await request("GET", "/api/system/routes");
    assert.strictEqual(res.status, 200);
    const routes = Array.isArray(res.data?.routes) ? res.data.routes : [];
    assert.ok(routes.length > 20, "route registry unexpectedly small");
    const missing = routes.filter((route) => {
      if (!route || typeof route !== "object") return true;
      if (!route.method || !route.path) return true;
      if (route.mutation === undefined) return true;
      if (!route.auth) return true;
      if (route.json_body === undefined) return true;
      return false;
    });
    assert.strictEqual(missing.length, 0, "route registry contains entries missing security metadata");
  });

  test("automated unauthenticated matrix respects route security metadata", "BLOCKER", async () => {
    const res = await request("GET", "/api/system/routes");
    assert.strictEqual(res.status, 200);
    const routes = Array.isArray(res.data?.routes) ? res.data.routes : [];
    const targetRoutes = routes.filter((route) => route.mutation && route.path.startsWith("/api/"));
    for (const route of targetRoutes.slice(0, 25)) {
      // limit runtime; focus on representative mutation routes
      const method = String(route.method || "POST").toUpperCase();
      let body = {};
      if (route.path === "/api/v1/actions") {
        body = { type: "UNKNOWN_TYPE", action_id: `matrix_${Date.now()}` };
      }
      // eslint-disable-next-line no-await-in-loop
      const call = await request(method, route.path, {
        useApiKey: false,
        useCookie: false,
        body,
      });
      assert.ok(call.status !== 500, `matrix ${method} ${route.path} returned 500`);
      assert.ok([400, 401, 403, 404, 405, 409, 415].includes(call.status), `matrix ${method} ${route.path} unexpected status ${call.status}`);
    }
  });

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    const id =
      t.id ||
      String(t.name || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    const row = {
      id,
      title: t.name,
      name: t.name,
      severity: t.severity,
      attack: t.attack || t.name,
      expected: t.expected || "No 500, no secret leak, correct status and security headers.",
      status: "passed",
      error: null,
      actual: "passed",
      request: null,
      response_meta: null,
      repro_curl: "",
      seed: rngState >>> 0,
    };
    try {
      // eslint-disable-next-line no-await-in-loop
      await t.fn();
      passed += 1;
      log(`✔ [${t.severity}] ${t.name}`);
    } catch (err) {
      failed += 1;
      row.status = "failed";
      row.error = String(err?.stack || err?.message || err);
      row.actual = String(err?.message || err || "failed");
      fail(`✖ [${t.severity}] ${t.name}`);
      fail(`  ${String(err?.message || err)}`);
    }
    if (lastTrace) {
      row.request = {
        method: lastTrace.method,
        path: lastTrace.urlPath,
        headers: lastTrace.headers,
        body: lastTrace.body,
      };
      row.response_meta = {
        status: lastTrace.status,
        headers: lastTrace.response_headers,
      };
      row.repro_curl = buildReproCurl(base, lastTrace);
    }
    results.push(row);
  }

  await new Promise((resolve) => server.close(resolve));
  close();

  fs.rmSync(tmpDir, { recursive: true, force: true });

  const report = {
    profile: "janitor-adversarial",
    generated_at: new Date().toISOString(),
    seed: rngState >>> 0,
    summary: {
      total: tests.length,
      passed,
      failed,
      duration_ms: Date.now() - startedAt,
      by_severity: {
        BLOCKER: results.filter((r) => r.severity === "BLOCKER").length,
        HIGH: results.filter((r) => r.severity === "HIGH").length,
        MEDIUM: results.filter((r) => r.severity === "MEDIUM").length,
      },
    },
    results,
  };
  const reportDir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, "janitor-security.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  if (failed > 0) {
    const firstFail = results.find((item) => item.status === "failed");
    if (firstFail) {
      const reproBundle = {
        generated_at: new Date().toISOString(),
        id: firstFail.id,
        title: firstFail.title,
        expected: firstFail.expected,
        actual: firstFail.actual,
        request: firstFail.request,
        response_meta: firstFail.response_meta,
        repro_curl: firstFail.repro_curl,
        seed: firstFail.seed,
      };
      fs.writeFileSync(
        path.join(reportDir, "janitor-repro.json"),
        `${JSON.stringify(reproBundle, null, 2)}\n`
      );
    }
    fail(`\nAdversarial Janitor complete: ${passed} passed, ${failed} failed`);
    fail(`Security report: ${reportPath}`);
    process.exit(1);
  }

  log(`\nAdversarial Janitor complete: ${passed} passed, ${failed} failed`);
  log(`Security report: ${reportPath}`);
}

run().catch((err) => {
  fail(err.stack || String(err));
  process.exit(1);
});
