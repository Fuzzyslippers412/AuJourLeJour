const PROVIDER = (process.env.LLM_PROVIDER || "qwen-oauth").toLowerCase();

const DEFAULT_MODEL = process.env.LLM_MODEL || "qwen2.5-coder:7b-instruct";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 15000;
const MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES) || 1;
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS) || 512;
const LLM_TEMPERATURE = Number(process.env.LLM_TEMPERATURE) || 0.2;

const { execFile } = require("child_process");
const QWEN_CLI_BIN = process.env.QWEN_CLI_BIN || "qwen";
const QWEN_CLI_MODEL = process.env.QWEN_CLI_MODEL || "";
const QWEN_OAUTH_MODEL = process.env.QWEN_OAUTH_MODEL || "qwen3-coder-plus";

const SYSTEM_PROMPT = `You are the Au Jour Le Jour Advisory Assistant running locally.
You must output ONLY valid JSON that matches the required schema for the task.
You do not compute financial totals, due date clamping, or business logic; the app does that deterministically.
You never write to the database. You only propose templates, messages, or actions for the user to confirm.
If ambiguous, ask a clarifying question in the \"questions\" or \"clarifying_question\" field.
Prefer short, direct phrasing. No moralizing. No shaming.
Never include any content outside of JSON.`;

const SYSTEM_PROMPT_AGENT = `You are Mamdou, the Finance Agent for Au Jour Le Jour.
Return ONLY valid JSON. No extra text.
Do not compute totals or business logic; use provided context.
Never write to the database; only propose actions.
If ambiguous, ask a clarifying question.`;

function buildPrompt(task, payload) {
  const input = JSON.stringify(payload || {}, null, 2);
  switch (task) {
    case "intake":
      return `TASK: Extract recurring bill templates from user_text. Return TemplateCandidate JSON.
Rules:
- Only include items that look like recurring monthly obligations or monthly targets.
- If due day is not stated, set due_day_guess = null and ask a question only if necessary.
- Guess category from common sense (Utilities, Insurance, Auto, Debt, Food, Subscriptions, Health, Buffer, Other).
- essential_guess: true for utilities/insurance/debt/food/transport; false for entertainment unless user says otherwise.
- autopay_guess: true only if user implies autopay.
- match_payee_key_guess: normalized short token if obvious.
- confidence: 0..1; if <0.6, add to warnings.
Output JSON object:
{
  "templates": [ ... ],
  "questions": [ ... ],
  "warnings": [ ... ]
}
INPUT:
${input}`;
    case "nudges":
      return `TASK: Convert trigger_events into short, helpful messages. Output NudgeMessage JSON.
Rules:
- 1 message per trigger_event (max 4 messages total; pick most urgent).
- Title <= 45 chars.
- Body <= 160 chars unless urgent (<= 220).
- No shame. Direct, calm.
- Always include a CTA if it points to a UI area.
Mapping:
- OVERDUE -> CTA OPEN_OVERDUE
- DUE_SOON -> CTA OPEN_DUE_SOON
- FREE_FOR_MONTH -> CTA OPEN_SPEND_GUARD
- NEW_MONTH_START -> CTA OPEN_TEMPLATES
Output JSON object:
{
  "messages": [ ... ]
}
INPUT:
${input}`;
    case "habit":
      return `TASK: Create a short habit summary and 2-4 suggested rules. Output HabitSummary JSON.
Rules:
- Be factual; don't invent.
- No judgment.
- suggested_rules should be actionable in-app.
Output JSON object:
{
  "summary": { "high_level": [], "patterns": [], "suggested_rules": [] }
}
INPUT:
${input}`;
    case "command":
      return `TASK: Parse a user command into safe action proposals. Output ActionProposal JSON.
Rules:
- If ambiguous target, ask clarifying_question and set low confidence.
- needs_confirmation true for any write intent.
Output JSON object:
{
  "proposals": [ ... ],
  "errors": [ ... ]
}
INPUT:
${input}`;
    case "assist":
      return `TASK: Respond to the user_text with a short helpful answer. If context is provided, use it. Output JSON object:
{
  "text": "..."
}
Rules:
- Keep it under 120 words.
- No markdown.
- If the user asks about the app, explain plainly.
INPUT:
${input}`;
    case "agent":
      return `TASK: Decide whether user_text is (A) bill intake, (B) a command, or (C) a general question.
Output JSON object:
{
  "kind": "intake|command|ask",
  "answer": "string|null",
  "proposal": { ... } | null,
  "templates": [ ... ] | null,
  "questions": [ ... ],
  "warnings": [ ... ]
}
Rules:
- If user_text lists bills or amounts, use kind="intake" and output templates in TemplateCandidate schema (same fields as intake).
- If user_text asks to pay/skip/mark/update bills, use kind="command" and output a single ActionProposal object (same fields as command).
- If user_text is a question, use kind="ask" and put the response in "answer".
- If ambiguous, ask a clarifying question in "questions" (intake) or "proposal.clarifying_question" (command).
- For explicit commands ("mark tesla paid"), you may set proposal.needs_confirmation = false.
INPUT:
${input}`;
    default:
      throw new Error("Unknown advisor task");
  }
}

function extractAuthUrl(text) {
  if (!text) return null;
  const match = text.match(/https?:\/\/\S*authorize\?user_code=\S+/i);
  return match ? match[0] : null;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function withRetries(fn) {
  let attempt = 0;
  let lastErr = null;
  const max = Math.max(0, MAX_RETRIES);
  while (attempt <= max) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      attempt += 1;
      if (attempt > max) break;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
  throw lastErr;
}

async function callOllama(prompt, systemPrompt) {
  if (process.env.LLM_DISABLED === "1") {
    return { ok: false, error: "LLM disabled" };
  }

  let res;
  try {
    res = await withRetries(() =>
      fetchWithTimeout(
        `${OLLAMA_URL}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEFAULT_MODEL,
            stream: false,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: prompt },
            ],
            options: { num_predict: LLM_MAX_TOKENS, temperature: LLM_TEMPERATURE },
          }),
        },
        REQUEST_TIMEOUT_MS
      )
    );
  } catch (err) {
    return { ok: false, error: `LLM request failed: ${err.message}` };
  }

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `LLM request failed: ${text}` };
  }

  const data = await res.json();
  const content = data?.message?.content || "";
  return { ok: true, content };
}

function execFileAsync(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 5 },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function extractQwenCliContent(output) {
  if (!output) return "";
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      const result = [...parsed].reverse().find((item) => item.type === "result");
      if (result && typeof result.result === "string") return result.result;
      const assistant = [...parsed].reverse().find((item) => item.type === "assistant");
      const content = assistant?.message?.content;
      if (Array.isArray(content)) {
        return content
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .join("");
      }
    }
  } catch (err) {
    // ignore JSON parse errors, fall back to raw
  }
  return String(output).trim();
}

async function callQwenCli(prompt, systemPrompt) {
  if (process.env.LLM_DISABLED === "1") {
    return { ok: false, error: "LLM disabled" };
  }

  const args = ["--prompt", `${systemPrompt}\n\n${prompt}`, "--output-format", "json"];
  if (QWEN_CLI_MODEL) {
    args.push("--model", QWEN_CLI_MODEL);
  }

  let result;
  try {
    result = await withRetries(() => execFileAsync(QWEN_CLI_BIN, args, REQUEST_TIMEOUT_MS));
  } catch (err) {
    if (err.code === "ENOENT") {
      return {
        ok: false,
        error: "Qwen CLI not found. Install it and run `qwen` once to login.",
      };
    }
    const stderr = err.stderr ? String(err.stderr) : "";
    const stdout = err.stdout ? String(err.stdout) : "";
    const message = stderr || stdout || err.message || "LLM request failed";
    const authUrl = extractAuthUrl(message);
    return { ok: false, error: message, auth_url: authUrl };
  }

  const content = extractQwenCliContent(result.stdout || result.stderr || "");
  if (!content) {
    return { ok: false, error: "LLM returned empty response" };
  }
  return { ok: true, content };
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1) throw err;
    const candidate = text.slice(first, last + 1);
    return JSON.parse(candidate);
  }
}

async function callQwenOAuth(prompt, oauth, systemPrompt) {
  if (process.env.LLM_DISABLED === "1") {
    return { ok: false, error: "LLM disabled" };
  }
  if (!oauth || !oauth.access_token || !oauth.resource_url) {
    return { ok: false, error: "Agent not connected" };
  }

  const base = String(oauth.resource_url || "").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  let res;
  try {
    res = await withRetries(() =>
      fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${oauth.access_token}`,
          },
          body: JSON.stringify({
            model: QWEN_OAUTH_MODEL,
            stream: false,
            max_tokens: LLM_MAX_TOKENS,
            temperature: LLM_TEMPERATURE,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: prompt },
            ],
          }),
        },
        REQUEST_TIMEOUT_MS
      )
    );
  } catch (err) {
    return { ok: false, error: `LLM request failed: ${err.message}` };
  }

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401) {
      return { ok: false, error: "Agent login expired. Reconnect." };
    }
    return { ok: false, error: `LLM request failed: ${text}` };
  }

  const data = await res.json().catch(() => ({}));
  const content = data?.choices?.[0]?.message?.content || "";
  return { ok: true, content };
}

async function query(task, payload, options = {}) {
  const prompt = buildPrompt(task, payload);
  const systemPrompt = task === "agent" ? SYSTEM_PROMPT_AGENT : SYSTEM_PROMPT;
  let response;
  const provider = (options.provider || PROVIDER).toLowerCase();
  if (provider === "ollama") {
    response = await callOllama(prompt, systemPrompt);
  } else if (provider === "qwen-cli" || provider === "qwen") {
    response = await callQwenCli(prompt, systemPrompt);
  } else if (provider === "qwen-oauth") {
    response = await callQwenOAuth(prompt, options.oauth, systemPrompt);
  } else {
    return { ok: false, error: `Unknown LLM provider: ${provider}` };
  }
  if (!response.ok) {
    return { ok: false, error: response.error };
  }
  try {
    const parsed = extractJson(response.content);
    return { ok: true, data: parsed };
  } catch (err) {
    const authUrl = extractAuthUrl(response.content);
    if (authUrl) {
      return { ok: false, error: "Agent login required", auth_url: authUrl };
    }
    return { ok: false, error: "Invalid JSON from LLM" };
  }
}

module.exports = { query };
