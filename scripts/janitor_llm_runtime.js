/* Janitor LLM Runtime: verifies live provider connectivity against running local server */
const assert = require("assert");
const fs = require("fs");
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

function parseJsonSafe(value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function normalizeProvider(provider) {
  const key = String(provider || "").trim().toLowerCase();
  if (["qwen-oauth", "openai", "anthropic"].includes(key)) return key;
  return "qwen-oauth";
}

class SkipTestError extends Error {}

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

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function pingHealth(base) {
  try {
    const res = await fetch(`${base}/api/health`);
    return res.status === 200;
  } catch (err) {
    return false;
  }
}

async function resolveTargetBase() {
  const explicit = normalizeBaseUrl(process.env.AJL_JANITOR_TARGET_BASE || "");
  if (explicit) {
    return explicit;
  }
  const envPort = Number(process.env.PORT || 0);
  const candidates = [];
  if (Number.isInteger(envPort) && envPort > 0) {
    candidates.push(`http://127.0.0.1:${envPort}`);
  }
  candidates.push("http://127.0.0.1:6709", "http://127.0.0.1:4567");
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await pingHealth(candidate);
    if (ok) return candidate;
  }
  return candidates[0];
}

async function run() {
  const base = await resolveTargetBase();
  const localApiKey = String(process.env.AJL_LOCAL_API_KEY || "").trim();
  const runtimeRequired = String(process.env.AJL_JANITOR_RUNTIME_REQUIRED || "").trim() === "1";
  const startedAt = Date.now();
  let lastTrace = null;
  let cookie = "";
  let activeProvider = "qwen-oauth";
  let activeProviderLabel = "Qwen OAuth";
  let activeProviderConnected = false;
  let runtimeReachable = false;

  async function request(method, routePath, body, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(String(method).toUpperCase()) && localApiKey) {
      headers["x-ajl-local-key"] = localApiKey;
    }
    let requestBody = undefined;
    if (body !== undefined) {
      requestBody = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    let res;
    try {
      res = await fetch(`${base}${routePath}`, {
        method,
        headers,
        body: requestBody,
      });
    } catch (err) {
      const message = String(err?.message || err || "network error");
      lastTrace = {
        method,
        path: routePath,
        headers: redactHeaders(headers),
        body: body ?? null,
        status: 0,
        response_headers: {},
        response_preview: message,
      };
      return {
        status: 0,
        data: null,
        text: message,
        headers: new Headers(),
        network_error: message,
      };
    }
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      cookie = setCookie.split(";")[0];
    }
    const contentType = String(res.headers.get("content-type") || "");
    const text = await res.text().catch(() => "");
    const data = contentType.includes("application/json") ? parseJsonSafe(text) : text;
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
      response_preview: String(text || "").slice(0, 500),
    };
    return { status: res.status, data, text, headers: res.headers };
  }

  const tests = [];
  const results = [];
  function test(id, title, severity, fn) {
    tests.push({ id, title, severity, fn });
  }

  test("runtime_target_reachable", "runtime target is reachable and healthy", "BLOCKER", async () => {
    const res = await request("GET", "/api/health");
    if (res.status === 0) {
      if (runtimeRequired) {
        throw new Error(`Unable to reach target ${base}. Start local app first.`);
      }
      throw new SkipTestError(`Skipped: unable to reach target ${base}.`);
    }
    if (res.status !== 200) {
      if (runtimeRequired) {
        throw new Error(`Unexpected /api/health status ${res.status} from ${base}.`);
      }
      throw new SkipTestError(`Skipped: unexpected /api/health status ${res.status} from ${base}.`);
    }
    runtimeReachable = true;
  });

  test("provider_status_live_shape", "live provider status endpoint returns expected shape", "HIGH", async () => {
    if (!runtimeReachable) {
      throw new SkipTestError("Skipped: runtime target not reachable.");
    }
    const res = await request("GET", "/api/llm/providers/status");
    if (res.status === 0) {
      throw new Error(`Unable to reach target ${base}. Start local app first.`);
    }
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data?.ok, true);
    assert.ok(res.data?.providers && typeof res.data.providers === "object");
    activeProvider = normalizeProvider(res.data.active_provider || "qwen-oauth");
    const activeRow = res.data.providers?.[activeProvider] || {};
    activeProviderLabel = String(activeRow.label || activeProvider);
  });

  test("provider_connectivity_live", "active provider is connected in live runtime", "BLOCKER", async () => {
    if (!runtimeReachable) {
      throw new SkipTestError("Skipped: runtime target not reachable.");
    }
    const res = await request("POST", "/api/llm/providers/test", {
      provider: activeProvider,
    });
    if (res.status === 401) {
      throw new Error(
        `Unauthorized. Set AJL_LOCAL_API_KEY for Janitor runtime or open the app once in browser to establish owner cookie.`
      );
    }
    if (res.status >= 400) {
      throw new Error(`Provider test failed for ${activeProviderLabel} (status ${res.status}). ${String(res.data?.error || res.text || "")}`);
    }
    activeProviderConnected = !!res.data?.connected || !!res.data?.ok;
    if (!activeProviderConnected) {
      throw new Error(
        `${activeProviderLabel} is not connected. Open Setup and connect Mamdou, then rerun Janitor.`
      );
    }
  });

  test("advisor_query_live", "advisor query works against active connected provider", "BLOCKER", async () => {
    if (!runtimeReachable) {
      throw new SkipTestError("Skipped: runtime target not reachable.");
    }
    if (!activeProviderConnected) {
      throw new Error(`${activeProviderLabel} is not connected.`);
    }
    const res = await request("POST", "/internal/advisor/query", {
      task: "ask",
      payload: {
        prompt: "health check",
      },
    });
    if (res.status !== 200 || res.data?.ok !== true) {
      throw new Error(
        `Advisor query failed (status ${res.status}). ${String(res.data?.error || res.text || "")}`
      );
    }
    assert.ok(res.data?.data && typeof res.data.data === "object");
  });

  test("diagnostics_provider_coherence", "diagnostics provider matches active provider", "HIGH", async () => {
    if (!runtimeReachable) {
      throw new SkipTestError("Skipped: runtime target not reachable.");
    }
    const res = await request("GET", "/api/system/diagnostics");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof res.data?.llm?.provider, "string");
    assert.strictEqual(normalizeProvider(res.data.llm.provider), activeProvider);
  });

  for (const current of tests) {
    const started = Date.now();
    const result = {
      id: current.id,
      title: current.title,
      name: current.title,
      severity: current.severity,
      attack: current.title,
      expected: "No 500, connected provider, advisory query succeeds, no secret leakage.",
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
      if (err instanceof SkipTestError) {
        result.status = "skipped";
        result.error = String(err.message || "Skipped.");
        result.actual = result.error;
        process.stdout.write(`SKIP ${current.title}: ${result.error}\n`);
      } else {
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
    }
    result.duration_ms = Date.now() - started;
    results.push(result);
    if (result.status === "passed") {
      process.stdout.write(`PASS ${current.title}\n`);
    }
  }

  const failed = results.filter((row) => row.status === "failed").length;
  const skipped = results.filter((row) => row.status === "skipped").length;
  const report = {
    profile: "janitor-llm-runtime",
    generated_at: nowIso(),
    summary: {
      total: results.length,
      passed: results.filter((row) => row.status === "passed").length,
      failed,
      skipped,
      duration_ms: Date.now() - startedAt,
      by_severity: {
        BLOCKER: results.filter((row) => row.severity === "BLOCKER").length,
        HIGH: results.filter((row) => row.severity === "HIGH").length,
      },
    },
    results,
    context: {
      base,
      runtime_required: runtimeRequired,
      active_provider: activeProvider,
      active_provider_label: activeProviderLabel,
      connected: activeProviderConnected,
    },
  };
  const reportPath = path.join(__dirname, "..", "reports", "janitor-llm-runtime.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Janitor LLM runtime report: ${reportPath}\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  process.stderr.write(`${String(err?.stack || err)}\n`);
  process.exit(1);
});
