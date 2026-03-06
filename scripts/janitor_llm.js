/* Janitor LLM: provider + advisory connectivity and safety checks */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function nowIso() {
  return new Date().toISOString();
}

function redactHeaders(headers = {}) {
  const out = {};
  Object.entries(headers).forEach(([key, value]) => {
    if (/authorization|x-ajl-local-key|cookie|x-api-key/i.test(key)) {
      out[key] = "[REDACTED]";
      return;
    }
    out[key] = value;
  });
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
  return `curl -i -X ${trace.method || "GET"} ${headerArgs}${bodyArg} ${JSON.stringify(`${base}${trace.path || ""}`)}`.trim();
}

async function run() {
  const startedAt = Date.now();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ajl-janitor-llm-"));
  const localApiKey = "janitor-llm-local-key";
  process.env.AJL_DATA_DIR = tmpDir;
  process.env.AJL_DB_PATH = path.join(tmpDir, "ajl.sqlite");
  process.env.AJL_BACKUP_DIR = path.join(tmpDir, "backups");
  process.env.AJL_LOCK_FILE = path.join(tmpDir, "server.lock");
  process.env.AJL_DISABLE_LOCK = "1";
  process.env.AJL_LOCAL_API_KEY = localApiKey;
  process.env.AJL_LLM_MOCK = "1";
  process.env.AJL_MUTATION_RATE_PER_MIN = "10000";
  process.env.AJL_MUTATION_RATE_WINDOW_MS = "2000";

  const { app, close } = require("../server");
  const server = await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  let lastTrace = null;

  async function request(method, routePath, body, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) {
      headers["x-ajl-local-key"] = localApiKey;
    }
    let requestBody = undefined;
    if (body !== undefined) {
      requestBody = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(`${base}${routePath}`, {
      method,
      headers,
      body: requestBody,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      cookie = setCookie.split(";")[0];
    }
    const contentType = String(res.headers.get("content-type") || "");
    const data = contentType.includes("application/json")
      ? await res.json().catch(() => null)
      : await res.text().catch(() => "");
    const responseHeaders = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    lastTrace = {
      method,
      path: routePath,
      headers: redactHeaders(headers),
      body: body ?? null,
      status: res.status,
      response_headers: redactHeaders(responseHeaders),
      response_preview:
        typeof data === "string"
          ? data.slice(0, 500)
          : JSON.stringify(data || {}).slice(0, 500),
    };
    return { status: res.status, data, headers: res.headers };
  }

  const tests = [];
  const results = [];
  function test(id, title, severity, fn) {
    tests.push({ id, title, severity, fn });
  }

  test("providers_status_shape", "provider status endpoint returns expected shape", "HIGH", async () => {
    const res = await request("GET", "/api/llm/providers/status");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(typeof res.data.active_provider, "string");
    assert.ok(res.data.providers && typeof res.data.providers === "object");
    ["qwen-oauth", "openai", "anthropic"].forEach((provider) => {
      assert.ok(res.data.providers[provider], `missing provider entry: ${provider}`);
    });
  });

  test("provider_select_rejects_unknown", "provider select rejects unsupported provider", "HIGH", async () => {
    const res = await request("POST", "/api/llm/providers/select", {
      provider: "unknown-provider",
    });
    assert.strictEqual(res.status, 400);
  });

  test("openai_requires_key_before_select", "OpenAI cannot be activated without key", "HIGH", async () => {
    const res = await request("POST", "/api/llm/providers/select", {
      provider: "openai",
    });
    assert.strictEqual(res.status, 400);
    assert.ok(String(res.data?.error || "").toLowerCase().includes("configured"));
  });

  test("connect_openai_key_success", "OpenAI key connection path succeeds in mock mode", "HIGH", async () => {
    const res = await request("POST", "/api/llm/providers/connect/api-key", {
      provider: "openai",
      api_key: "sk-test-openai-key-12345678901234567890",
      model: "gpt-4o-mini",
      base_url: "https://api.openai.com/v1",
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.provider, "openai");
    assert.strictEqual(res.data.state?.active_provider, "openai");
  });

  test("openai_provider_test_success", "OpenAI provider test endpoint succeeds after connection", "HIGH", async () => {
    const res = await request("POST", "/api/llm/providers/test", {
      provider: "openai",
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.provider, "openai");
  });

  test("advisor_query_with_openai", "advisor query succeeds with connected OpenAI provider", "HIGH", async () => {
    const res = await request("POST", "/internal/advisor/query", {
      task: "assist",
      payload: {
        user_text: "hello",
        context: {},
      },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.ok(res.data.data && typeof res.data.data === "object");
  });

  test("disconnect_openai_provider", "disconnecting OpenAI revokes configured state", "HIGH", async () => {
    const dis = await request("DELETE", "/api/llm/providers/disconnect?provider=openai");
    assert.strictEqual(dis.status, 200);
    const status = await request("GET", "/api/llm/providers/status");
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.data.providers?.openai?.configured, false);
  });

  test("qwen_test_reports_not_connected", "qwen provider test reports not connected without OAuth", "HIGH", async () => {
    const select = await request("POST", "/api/llm/providers/select", {
      provider: "qwen-oauth",
    });
    assert.strictEqual(select.status, 200);
    const res = await request("POST", "/api/llm/providers/test", {
      provider: "qwen-oauth",
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.provider, "qwen-oauth");
    assert.strictEqual(res.data.connected, false);
  });

  test("advisor_query_requires_connection_for_qwen", "advisor query returns 503 when qwen is active but not connected", "HIGH", async () => {
    const res = await request("POST", "/internal/advisor/query", {
      task: "assist",
      payload: {
        user_text: "can you help",
      },
    });
    assert.strictEqual(res.status, 503);
    assert.ok(String(res.data?.error || "").toLowerCase().includes("connect"));
  });

  test("connect_anthropic_key_success", "Anthropic key connection path succeeds in mock mode", "HIGH", async () => {
    const res = await request("POST", "/api/llm/providers/connect/api-key", {
      provider: "anthropic",
      api_key: "sk-ant-test-anthropic-key-12345678901234567890",
      model: "claude-3-5-sonnet-latest",
      base_url: "https://api.anthropic.com/v1",
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.provider, "anthropic");
    assert.strictEqual(res.data.state?.active_provider, "anthropic");
  });

  test("advisor_query_with_anthropic", "advisor query succeeds with connected Anthropic provider", "HIGH", async () => {
    const res = await request("POST", "/internal/advisor/query", {
      task: "assist",
      payload: {
        user_text: "status",
      },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.ok(res.data.data && typeof res.data.data === "object");
  });

  test("diagnostics_exposes_provider_state", "diagnostics endpoint includes provider state", "HIGH", async () => {
    const res = await request("GET", "/api/system/diagnostics");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.data.llm?.provider, "string");
    assert.ok(res.data.llm?.providers && typeof res.data.llm.providers === "object");
  });

  for (const current of tests) {
    const started = Date.now();
    const result = {
      id: current.id,
      title: current.title,
      name: current.title,
      severity: current.severity,
      attack: current.title,
      expected: "No 500, no secret leak, correct status and provider behavior.",
      status: "passed",
      error: null,
      actual: "passed",
      request: null,
      response_meta: null,
      repro_curl: "",
      duration_ms: 0,
    };
    try {
      // eslint-disable-next-line no-await-in-loop
      await current.fn();
    } catch (err) {
      result.status = "failed";
      result.error = String(err?.message || err);
      result.actual = result.error;
      result.request = lastTrace
        ? {
            method: lastTrace.method,
            path: lastTrace.path,
            headers: lastTrace.headers,
            body: lastTrace.body,
          }
        : null;
      result.response_meta = lastTrace
        ? {
            status: lastTrace.status,
            headers: lastTrace.response_headers,
            preview: lastTrace.response_preview,
          }
        : null;
      result.repro_curl = buildReproCurl(base, lastTrace);
      process.stderr.write(`FAIL ${current.title}: ${result.error}\n`);
    }
    result.duration_ms = Date.now() - started;
    results.push(result);
    if (result.status === "passed") {
      process.stdout.write(`PASS ${current.title}\n`);
    }
  }

  const failed = results.filter((row) => row.status === "failed").length;
  const report = {
    profile: "janitor-llm",
    generated_at: nowIso(),
    summary: {
      total: results.length,
      passed: results.length - failed,
      failed,
      duration_ms: Date.now() - startedAt,
      by_severity: {
        HIGH: results.length,
      },
    },
    results,
  };
  const reportPath = path.join(__dirname, "..", "reports", "janitor-llm.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Janitor LLM report: ${reportPath}\n`);

  await new Promise((resolve) => server.close(resolve));
  close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  process.stderr.write(`${String(err?.stack || err)}\n`);
  process.exit(1);
});
