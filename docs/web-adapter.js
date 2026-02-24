(() => {
  window.AJL_WEB_MODE = true;
  const DB_KEY = "AJL_WEB_DB_V1";
  const META_KEY = "AJL_WEB_META_V1";
  const MAX_BYTES = 4_500_000;

  const realFetch = window.fetch.bind(window);

  function now() {
    return Date.now();
  }

  function defaultDb() {
    const t = now();
    return {
      schemaVersion: 1,
      createdAt: t,
      updatedAt: t,
      data: {
        templates: [],
        instances: [],
        payment_events: [],
        instance_events: [],
        month_settings: [],
        sinking_funds: [],
        sinking_events: [],
        agent_command_log: [],
        assistant_chat: [],
        settings: {
          defaults: { sort: "due_date", dueSoonDays: 7, defaultPeriod: "month" },
          categories: [],
        },
      },
    };
  }

  function jsonResponse(status, payload) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function ok(data, status = 200) {
    return jsonResponse(status, { ok: true, data });
  }

  function bad(code, message, details = {}, status = 400) {
    return jsonResponse(status, { ok: false, error: { code, message, details } });
  }

  function safeParse(str) {
    try {
      return { ok: true, value: JSON.parse(str) };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  function safeLoadDb() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (!raw) return { ok: true, db: defaultDb(), created: true };
      const parsed = safeParse(raw);
      if (!parsed.ok) {
        return { ok: false, error: { code: "STORAGE_PARSE_FAIL", message: "Stored data could not be parsed", details: {} } };
      }
      return { ok: true, db: parsed.value, created: false };
    } catch (err) {
      return { ok: false, error: { code: "STORAGE_UNAVAILABLE", message: "localStorage unavailable", details: {} } };
    }
  }

  function safeSaveDb(db) {
    try {
      db.updatedAt = now();
      const raw = JSON.stringify(db);
      if (raw.length > MAX_BYTES) {
        return { ok: false, error: { code: "STORAGE_QUOTA_RISK", message: "Data too large for localStorage", details: { bytes: raw.length } } };
      }
      localStorage.setItem(DB_KEY, raw);
      localStorage.setItem(META_KEY, JSON.stringify({ updatedAt: db.updatedAt, schemaVersion: db.schemaVersion }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: { code: "STORAGE_QUOTA", message: "Failed to write to localStorage", details: {} } };
    }
  }

  function ensureDbInitialized() {
    const loaded = safeLoadDb();
    if (!loaded.ok) return loaded;
    if (loaded.created) {
      const saved = safeSaveDb(loaded.db);
      if (!saved.ok) return saved;
    }
    return { ok: true, db: loaded.db };
  }

  async function parseJsonBody(req) {
    try {
      const text = await req.text();
      if (!text) return { ok: true, body: null };
      const parsed = safeParse(text);
      if (!parsed.ok) return { ok: false, error: { code: "INVALID_INPUT", message: "Invalid JSON body", details: {} } };
      return { ok: true, body: parsed.value };
    } catch (err) {
      return { ok: false, error: { code: "INVALID_INPUT", message: "Unable to read request body", details: {} } };
    }
  }

  function uuid() {
    return crypto && crypto.randomUUID ? crypto.randomUUID() : `id_${Date.now()}_${Math.random()}`;
  }

  function validId(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function validYearMonth(year, month) {
    return Number.isInteger(year) && Number.isInteger(month) && year >= 2000 && year <= 2100 && month >= 1 && month <= 12;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function todayDate() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function nowIsoLocal() {
    const now = new Date();
    const offset = -now.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const hours = pad2(Math.floor(Math.abs(offset) / 60));
    const minutes = pad2(Math.abs(offset) % 60);
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 19);
    return `${local}${sign}${hours}:${minutes}`;
  }

  function clampDueDay(year, month, dueDay) {
    const last = new Date(year, month, 0).getDate();
    return Math.min(Math.max(1, Number(dueDay) || 1), last);
  }

  function toDateString(year, month, day) {
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  function validateDateString(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return "Invalid date";
    const date = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(date.valueOf())) return "Invalid date";
    return null;
  }

  function parseYearMonth(params) {
    const rawYear = params.get("year");
    const rawMonth = params.get("month");
    if (rawYear == null || rawMonth == null) return null;
    const year = Number(rawYear);
    const month = Number(rawMonth);
    if (!validYearMonth(year, month)) return null;
    return { year, month };
  }

  function resolveMonthsPerCycle(cadence, monthsPerCycle) {
    if (cadence === "yearly") return 12;
    if (cadence === "quarterly") return 3;
    const parsed = Number(monthsPerCycle);
    if (!Number.isInteger(parsed) || parsed < 1) return 1;
    return parsed;
  }

  function computeMonthsRemaining(refDate, dueDate) {
    if (!(dueDate instanceof Date) || Number.isNaN(dueDate.valueOf())) return 0;
    if (dueDate <= refDate) return 0;
    const refY = refDate.getFullYear();
    const refM = refDate.getMonth() + 1;
    const refD = refDate.getDate();
    const dueY = dueDate.getFullYear();
    const dueM = dueDate.getMonth() + 1;
    const dueD = dueDate.getDate();
    let months = (dueY - refY) * 12 + (dueM - refM);
    if (dueD >= refD) months += 1;
    return months;
  }

  function computeSinkingFundView(fund, balance, refDate) {
    const target = Number(fund.target_amount || 0);
    const dueDate = new Date(`${fund.due_date}T00:00:00`);
    const monthsRemaining = computeMonthsRemaining(refDate, dueDate);
    let monthlyContrib = 0;
    if (target > 0 && balance < target && monthsRemaining > 0) {
      monthlyContrib = (target - balance) / monthsRemaining;
    }
    if (balance >= target) monthlyContrib = 0;

    const monthsPerCycle = resolveMonthsPerCycle(fund.cadence, fund.months_per_cycle);
    const monthsElapsed = Math.max(0, Math.min(monthsPerCycle, monthsPerCycle - monthsRemaining));
    const expectedSaved = monthsPerCycle > 0 ? target * (monthsElapsed / monthsPerCycle) : 0;
    const progressRatio = target > 0 ? balance / target : 1;

    let status = "on_track";
    if (dueDate <= refDate) status = "due";
    else if (balance >= target) status = "ready";
    else if (balance + 0.01 < expectedSaved) status = "behind";

    return {
      ...fund,
      balance,
      monthly_contrib: Number(monthlyContrib.toFixed(2)),
      months_remaining: monthsRemaining,
      status,
      progress_ratio: progressRatio,
      expected_saved: Number(expectedSaved.toFixed(2)),
    };
  }

  function computeSummary(instances, { year, month, essentialsOnly }) {
    const list = essentialsOnly ? instances.filter((item) => item.essential_snapshot) : instances;
    const today = todayDate();
    let required = 0;
    let paid = 0;
    let remaining = 0;
    let overduePending = false;
    list.forEach((item) => {
      if (item.status === "skipped") return;
      required += Number(item.amount || 0);
      paid += Number(item.amount_paid || 0);
      remaining += Number(item.amount_remaining || 0);
      if (
        item.status_derived !== "paid" &&
        item.status_derived !== "skipped" &&
        item.due_date &&
        item.due_date < today
      ) {
        overduePending = true;
      }
    });
    const daysInMonth = new Date(year, month, 0).getDate();
    const needDailyExact = daysInMonth > 0 ? required / daysInMonth : 0;
    const needWeeklyExact = needDailyExact * 7;
    const freeForMonth = required > 0 && remaining === 0 && !overduePending;
    return {
      required_month: Number(required.toFixed(2)),
      paid_month: Number(paid.toFixed(2)),
      remaining_month: Number(remaining.toFixed(2)),
      need_daily_exact: Number(needDailyExact.toFixed(2)),
      need_weekly_exact: Number(needWeeklyExact.toFixed(2)),
      free_for_month: freeForMonth,
    };
  }

  function getData(db) {
    if (!db.data) db.data = defaultDb().data;
    return db.data;
  }

  function getTemplates(db) {
    return getData(db).templates || [];
  }

  function getInstances(db) {
    return getData(db).instances || [];
  }

  function getPayments(db) {
    return getData(db).payment_events || [];
  }

  function getInstanceEvents(db) {
    return getData(db).instance_events || [];
  }

  function logInstanceEvent(db, instanceId, type, detail) {
    if (!instanceId || !type) return;
    getInstanceEvents(db).push({
      id: uuid(),
      instance_id: instanceId,
      type,
      detail: detail || null,
      created_at: new Date().toISOString(),
    });
  }

  function getSinkingFunds(db) {
    return getData(db).sinking_funds || [];
  }

  function getSinkingEvents(db) {
    return getData(db).sinking_events || [];
  }

  function getMonthSettings(db) {
    return getData(db).month_settings || [];
  }

  function getSettings(db) {
    const settings = getData(db).settings;
    if (!settings || typeof settings !== "object") {
      return { defaults: { sort: "due_date", dueSoonDays: 7, defaultPeriod: "month" }, categories: [] };
    }
    const defaults = settings.defaults || {};
    return {
      defaults: {
        sort: defaults.sort || "due_date",
        dueSoonDays: Number(defaults.dueSoonDays || 7),
        defaultPeriod: defaults.defaultPeriod || "month",
      },
      categories: Array.isArray(settings.categories) ? settings.categories.filter(Boolean) : [],
    };
  }

  function ensureMonth(db, year, month) {
    if (!validYearMonth(year, month)) return;
    const templates = getTemplates(db).filter((t) => t.active !== false);
    const instances = getInstances(db);
    const stamp = new Date().toISOString();
    templates.forEach((template) => {
      if (!validId(template.id)) return;
      const exists = instances.find((inst) => inst.template_id === template.id && inst.year === year && inst.month === month);
      if (exists) return;
      const dueDay = clampDueDay(year, month, template.due_day);
      const dueDate = toDateString(year, month, dueDay);
      const instanceId = uuid();
      instances.push({
        id: instanceId,
        template_id: template.id,
        year,
        month,
        name_snapshot: template.name,
        category_snapshot: template.category || null,
        amount: Number(template.amount_default || 0),
        due_date: dueDate,
        autopay_snapshot: !!template.autopay,
        essential_snapshot: template.essential !== false,
        status: "pending",
        paid_date: null,
        note: template.default_note || null,
        created_at: stamp,
        updated_at: stamp,
      });
      logInstanceEvent(db, instanceId, "created", {
        source: "template",
        name: template.name,
        due_date: dueDate,
        amount: Number(template.amount_default || 0),
      });
    });
  }

  function attachPayments(db, instances) {
    const payments = getPayments(db);
    const totals = new Map();
    payments.forEach((p) => {
      totals.set(p.instance_id, (totals.get(p.instance_id) || 0) + Number(p.amount || 0));
    });
    return instances.map((inst) => {
      const amountPaid = Number(totals.get(inst.id) || 0);
      const amountDue = Number(inst.amount || 0);
      return {
        ...inst,
        amount_paid: amountPaid,
        amount_remaining: Math.max(0, amountDue - amountPaid),
      };
    });
  }

  function getInstancesForMonth(db, year, month) {
    const rows = getInstances(db).filter((inst) => inst.year === year && inst.month === month);
    rows.sort((a, b) =>
      String(a.due_date).localeCompare(String(b.due_date)) ||
      String(a.name_snapshot).localeCompare(String(b.name_snapshot), undefined, { sensitivity: "base" })
    );
    return attachPayments(db, rows);
  }

  function getPaymentsForMonth(db, year, month) {
    const instances = getInstances(db).filter((inst) => inst.year === year && inst.month === month);
    const ids = new Set(instances.map((i) => i.id));
    const rows = getPayments(db).filter((p) => ids.has(p.instance_id));
    rows.sort((a, b) => String(b.paid_date).localeCompare(String(a.paid_date)));
    return rows;
  }

  function getSinkingBalances(db) {
    const rows = getSinkingEvents(db);
    const map = new Map();
    rows.forEach((row) => {
      const delta = row.type === "WITHDRAWAL" ? -Number(row.amount || 0) : Number(row.amount || 0);
      map.set(row.fund_id, (map.get(row.fund_id) || 0) + delta);
    });
    return map;
  }

  function getSinkingFundsView(db, year, month, includeInactive) {
    const refDate = new Date(year, month - 1, 1);
    let funds = getSinkingFunds(db);
    if (!includeInactive) {
      funds = funds.filter((fund) => fund.active);
    }
    funds.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    const balances = getSinkingBalances(db);
    return funds.map((fund) => computeSinkingFundView(fund, Number(balances.get(fund.id) || 0), refDate));
  }

  function hasContributionEvent(db, fundId, year, month) {
    const key = `${year}-${pad2(month)}`;
    return getSinkingEvents(db).some((evt) => evt.fund_id === fundId && evt.type === "CONTRIBUTION" && String(evt.event_date || "").startsWith(key));
  }

  function autoContributeForMonth(db, year, month) {
    const refDate = new Date(year, month - 1, 1);
    const funds = getSinkingFunds(db).filter((fund) => fund.active && fund.auto_contribute);
    const balances = getSinkingBalances(db);
    funds.forEach((fund) => {
      if (hasContributionEvent(db, fund.id, year, month)) return;
      const view = computeSinkingFundView(fund, Number(balances.get(fund.id) || 0), refDate);
      const amount = Number(view.monthly_contrib || 0);
      if (!Number.isFinite(amount) || amount <= 0) return;
      getSinkingEvents(db).push({
        id: uuid(),
        fund_id: fund.id,
        amount,
        type: "CONTRIBUTION",
        event_date: `${year}-${pad2(month)}-01`,
        note: "Auto contribution",
        created_at: new Date().toISOString(),
      });
    });
  }

  function applyTemplateToMonth(db, template, year, month) {
    if (!template || !validId(template.id) || !validYearMonth(year, month)) return;
    if (template.active) {
      ensureMonth(db, year, month);
    }
    const dueDay = clampDueDay(year, month, template.due_day);
    const dueDate = toDateString(year, month, dueDay);
    const instance = getInstances(db).find((inst) => inst.template_id === template.id && inst.year === year && inst.month === month);
    if (!instance) return;
    instance.name_snapshot = template.name;
    instance.category_snapshot = template.category || null;
    instance.amount = Number(template.amount_default || 0);
    instance.due_date = dueDate;
    instance.autopay_snapshot = !!template.autopay;
    instance.essential_snapshot = template.essential !== false;
    instance.updated_at = new Date().toISOString();
  }

  function deleteTemplateFromMonth(db, templateId, year, month) {
    if (!validId(templateId)) return;
    const instances = getInstances(db);
    const targets = instances.filter((inst) => {
      if (!Number.isInteger(year) || !Number.isInteger(month)) return inst.template_id === templateId;
      if (inst.template_id !== templateId) return false;
      if (inst.year > year) return true;
      if (inst.year === year && inst.month >= month) return true;
      return false;
    });
    const ids = new Set(targets.map((inst) => inst.id));
    const payments = getPayments(db).filter((p) => !ids.has(p.instance_id));
    getData(db).payment_events = payments;
    getData(db).instances = instances.filter((inst) => !ids.has(inst.id));
    getData(db).templates = getTemplates(db).filter((t) => t.id !== templateId);
  }

  function escapeCsv(value) {
    const raw = value == null ? "" : String(value);
    if (raw.includes(",") || raw.includes("\"") || raw.includes("\n")) {
      return `"${raw.replace(/\"/g, '""')}"`;
    }
    return raw;
  }

  function buildMonthCsv(rows) {
    const lines = [
      [
        "status",
        "name",
        "category",
        "amount",
        "due_date",
        "paid_date",
        "note",
        "autopay",
        "essential",
      ].join(","),
    ];
    rows.forEach((row) => {
      lines.push(
        [
          row.status,
          row.name_snapshot,
          row.category_snapshot || "",
          row.amount,
          row.due_date,
          row.paid_date || "",
          row.note || "",
          row.autopay_snapshot ? 1 : 0,
          row.essential_snapshot ? 1 : 0,
        ]
          .map(escapeCsv)
          .join(",")
      );
    });
    return lines.join("\n");
  }

  async function handleApi(req) {
    const url = new URL(req.url, window.location.origin);
    const path = url.pathname;
    const params = url.searchParams;

    const init = ensureDbInitialized();
    if (!init.ok) return jsonResponse(500, { ok: false, error: init.error });
    const db = init.db;

    if (path === "/api/health" && req.method === "GET") {
      return ok({ mode: "web", storage: "localStorage", schemaVersion: db.schemaVersion });
    }

    if (path.startsWith("/api/shares")) {
      return jsonResponse(503, { ok: false, error: { code: "UNAVAILABLE", message: "Sharing is available in the local app only.", details: {} } });
    }

    if (path === "/api/reset" && req.method === "POST") {
      const fresh = defaultDb();
      const saved = safeSaveDb(fresh);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok({ reset: true });
    }

    if (path === "/api/reset-local" && req.method === "POST") {
      try {
        localStorage.removeItem(DB_KEY);
        localStorage.removeItem(META_KEY);
      } catch (err) {
        // ignore
      }
      const fresh = defaultDb();
      const saved = safeSaveDb(fresh);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok({ reset: true });
    }

    if (path === "/api/settings" && req.method === "GET") {
      return ok(getSettings(db));
    }

    if (path === "/api/settings" && req.method === "POST") {
      const bodyRes = await parseJsonBody(req);
      if (!bodyRes.ok) return jsonResponse(400, { ok: false, error: bodyRes.error });
      const body = bodyRes.body || {};
      const defaults = body.defaults || {};
      const allowedSort = new Set(["due_date", "amount", "name", "status"]);
      const sort = allowedSort.has(defaults.sort) ? defaults.sort : "due_date";
      let dueSoonDays = Number(defaults.dueSoonDays ?? 7);
      if (!Number.isFinite(dueSoonDays) || dueSoonDays < 1 || dueSoonDays > 31) {
        dueSoonDays = 7;
      }
      const defaultPeriod = defaults.defaultPeriod === "month" ? "month" : "month";
      const categories = Array.isArray(body.categories)
        ? body.categories.map((c) => String(c || "").trim()).filter(Boolean)
        : [];
      getData(db).settings = {
        defaults: { sort, dueSoonDays, defaultPeriod },
        categories,
      };
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok(getSettings(db));
    }

    if (path === "/api/ensure-month" && req.method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return bad("INVALID_INPUT", "Invalid year/month");
      ensureMonth(db, parsed.year, parsed.month);
      autoContributeForMonth(db, parsed.year, parsed.month);
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok({ ok: true });
    }

    if (path === "/api/templates" && req.method === "GET") {
      const templates = getTemplates(db).slice();
      templates.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));
      return ok(templates);
    }

    if (path === "/api/templates" && req.method === "POST") {
      const bodyRes = await parseJsonBody(req);
      if (!bodyRes.ok) return jsonResponse(400, { ok: false, error: bodyRes.error });
      const body = bodyRes.body || {};
      const name = String(body.name || "").trim();
      const amount = Number(body.amount_default);
      const dueDay = Number(body.due_day);
      if (!name) return bad("INVALID_INPUT", "Name is required");
      if (!Number.isFinite(amount) || amount < 0) return bad("INVALID_INPUT", "Amount must be >= 0");
      if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return bad("INVALID_INPUT", "Due day must be 1-31");
      const stamp = new Date().toISOString();
      const template = {
        id: uuid(),
        name,
        category: body.category || null,
        amount_default: amount,
        due_day: dueDay,
        autopay: !!body.autopay,
        essential: body.essential !== false,
        active: body.active !== false,
        default_note: body.default_note || null,
        match_payee_key: body.match_payee_key || null,
        match_amount_tolerance: Number(body.match_amount_tolerance || 0),
        created_at: stamp,
        updated_at: stamp,
      };
      getTemplates(db).push(template);
      const parsed = parseYearMonth(params);
      if (parsed) {
        ensureMonth(db, parsed.year, parsed.month);
      }
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok(template, 201);
    }

    if (path.startsWith("/api/templates/") && req.method === "PUT") {
      const id = path.split("/")[3];
      const template = getTemplates(db).find((t) => t.id === id);
      if (!template) return bad("NOT_FOUND", "Template not found", {}, 404);
      const bodyRes = await parseJsonBody(req);
      if (!bodyRes.ok) return jsonResponse(400, { ok: false, error: bodyRes.error });
      const body = bodyRes.body || {};
      template.name = body.name || template.name;
      template.category = body.category ?? template.category;
      template.amount_default = Number(body.amount_default ?? template.amount_default);
      template.due_day = Number(body.due_day ?? template.due_day);
      template.autopay = !!body.autopay;
      template.essential = body.essential !== false;
      template.active = body.active !== false;
      template.default_note = body.default_note ?? template.default_note;
      template.match_payee_key = body.match_payee_key ?? template.match_payee_key;
      template.match_amount_tolerance = Number(body.match_amount_tolerance ?? template.match_amount_tolerance ?? 0);
      template.updated_at = new Date().toISOString();
      const parsed = parseYearMonth(params);
      if (parsed) {
        applyTemplateToMonth(db, template, parsed.year, parsed.month);
      }
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok({ ok: true });
    }

    if (path.startsWith("/api/templates/") && req.method === "DELETE") {
      const id = path.split("/")[3];
      const parsed = parseYearMonth(params);
      deleteTemplateFromMonth(db, id, parsed?.year, parsed?.month);
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok({ ok: true });
    }

    if (path.startsWith("/api/templates/") && path.endsWith("/archive") && req.method === "POST") {
      const id = path.split("/")[3];
      const template = getTemplates(db).find((t) => t.id === id);
      if (!template) return bad("NOT_FOUND", "Template not found", {}, 404);
      template.active = false;
      template.updated_at = new Date().toISOString();
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok({ ok: true });
    }

    if (path === "/api/instances" && req.method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return bad("INVALID_INPUT", "Invalid year/month");
      const rows = getInstancesForMonth(db, parsed.year, parsed.month);
      return ok(rows);
    }

    if (path.startsWith("/api/instances/") && path.endsWith("/events") && req.method === "GET") {
      const id = path.split("/")[3];
      if (!id) return bad("INVALID_INPUT", "Invalid id");
      const events = getInstanceEvents(db)
        .filter((evt) => evt.instance_id === id)
        .slice()
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return ok(events);
    }

    if (path === "/api/instance-events" && req.method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return bad("INVALID_INPUT", "Invalid year/month");
      const instances = getInstancesForMonth(db, parsed.year, parsed.month);
      const nameMap = new Map(instances.map((inst) => [inst.id, inst.name_snapshot]));
      const events = getInstanceEvents(db)
        .filter((evt) => nameMap.has(evt.instance_id))
        .slice()
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .map((evt) => ({
          ...evt,
          name: nameMap.get(evt.instance_id) || "Item",
        }));
      return ok(events);
    }

    if (path.startsWith("/api/instances/") && path.endsWith("/payments") && req.method === "POST") {
      const id = path.split("/")[3];
      const bodyRes = await parseJsonBody(req);
      if (!bodyRes.ok) return jsonResponse(400, { ok: false, error: bodyRes.error });
      const amount = Number(bodyRes.body?.amount);
      if (!Number.isFinite(amount) || amount <= 0) return bad("INVALID_INPUT", "Amount must be > 0");
      const instance = getInstances(db).find((inst) => inst.id === id);
      if (!instance) return bad("NOT_FOUND", "Instance not found", {}, 404);
      const payment = {
        id: uuid(),
        instance_id: id,
        amount,
        paid_date: todayDate(),
        created_at: new Date().toISOString(),
      };
      getPayments(db).push(payment);
      logInstanceEvent(db, id, "log_update", {
        amount,
        date: payment.paid_date,
        payment_id: payment.id,
      });
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      const updated = attachPayments(db, [instance])[0];
      return ok({ payment, instance: updated });
    }

    if (path.startsWith("/api/instances/") && path.endsWith("/undo-paid") && req.method === "POST") {
      const id = path.split("/")[3];
      getData(db).payment_events = getPayments(db).filter((p) => p.instance_id !== id);
      const instance = getInstances(db).find((inst) => inst.id === id);
      if (instance) {
        instance.status = "pending";
        instance.paid_date = null;
        instance.updated_at = new Date().toISOString();
      }
      logInstanceEvent(db, id, "status_changed", { from: "paid", to: "pending" });
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok(instance ? attachPayments(db, [instance])[0] : null);
    }

    if (path.startsWith("/api/instances/") && req.method === "PATCH") {
      const id = path.split("/")[3];
      const instance = getInstances(db).find((inst) => inst.id === id);
      if (!instance) return bad("NOT_FOUND", "Instance not found", {}, 404);
      const before = { ...instance };
      const bodyRes = await parseJsonBody(req);
      if (!bodyRes.ok) return jsonResponse(400, { ok: false, error: bodyRes.error });
      const body = bodyRes.body || {};
      const changes = {};
      let statusChange = null;
      let noteChange = null;
      if (body.amount !== undefined) {
        const amt = Number(body.amount);
        if (!Number.isFinite(amt) || amt < 0) return bad("INVALID_INPUT", "Amount must be >= 0");
        if (Number(before.amount || 0) !== amt) {
          changes.amount = { from: Number(before.amount || 0), to: amt };
        }
        instance.amount = amt;
      }
      if (body.due_date !== undefined) {
        const err = validateDateString(body.due_date);
        if (err) return bad("INVALID_INPUT", err);
        if (String(before.due_date || "") !== body.due_date) {
          changes.due_date = { from: before.due_date || "", to: body.due_date };
        }
        instance.due_date = body.due_date;
      }
      if (body.status !== undefined) {
        if (!["pending", "paid", "skipped"].includes(body.status)) return bad("INVALID_INPUT", "Invalid status");
        if (String(before.status || "") !== body.status) {
          statusChange = { from: before.status || "", to: body.status };
        }
        instance.status = body.status;
      }
      if (body.paid_date !== undefined) {
        const err = validateDateString(body.paid_date);
        if (err) return bad("INVALID_INPUT", err);
        instance.paid_date = body.paid_date;
      }
      if (body.note !== undefined) instance.note = body.note || null;
      if (body.name_snapshot !== undefined) instance.name_snapshot = String(body.name_snapshot || "");
      if (body.category_snapshot !== undefined) instance.category_snapshot = body.category_snapshot || null;
      instance.updated_at = new Date().toISOString();
      if (body.note !== undefined && String(before.note || "") !== String(body.note || "")) {
        noteChange = { from: before.note || "", to: body.note || "" };
      }
      if (body.name_snapshot !== undefined && String(before.name_snapshot || "") !== String(body.name_snapshot || "")) {
        changes.name = { from: before.name_snapshot || "", to: body.name_snapshot || "" };
      }
      if (body.category_snapshot !== undefined && String(before.category_snapshot || "") !== String(body.category_snapshot || "")) {
        changes.category = { from: before.category_snapshot || "", to: body.category_snapshot || "" };
      }
      if (statusChange) {
        const type =
          statusChange.to === "skipped"
            ? "skipped"
            : statusChange.from === "skipped"
            ? "unskipped"
            : "status_changed";
        logInstanceEvent(db, id, type, statusChange);
      }
      if (noteChange) {
        logInstanceEvent(db, id, "note_updated", noteChange);
      }
      const changeKeys = Object.keys(changes);
      if (changeKeys.length > 0) {
        logInstanceEvent(db, id, "edited", { changes });
      }
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok(attachPayments(db, [instance])[0]);
    }

    if (path === "/api/payments" && req.method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return bad("INVALID_INPUT", "Invalid year/month");
      const rows = getPaymentsForMonth(db, parsed.year, parsed.month);
      return ok(rows);
    }

    if (path.startsWith("/api/payments/") && req.method === "DELETE") {
      const id = path.split("/")[3];
      const payment = getPayments(db).find((p) => p.id === id);
      if (!payment) return bad("NOT_FOUND", "Update not found", {}, 404);
      getData(db).payment_events = getPayments(db).filter((p) => p.id !== id);
      logInstanceEvent(db, payment.instance_id, "update_removed", {
        amount: Number(payment.amount || 0),
        date: payment.paid_date,
        payment_id: payment.id,
      });
      const instance = getInstances(db).find((inst) => inst.id === payment.instance_id);
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok({ instance_id: payment.instance_id, instance: instance ? attachPayments(db, [instance])[0] : null });
    }

    if (path === "/api/sinking-funds" && req.method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return bad("INVALID_INPUT", "Invalid year/month");
      const includeInactive = params.get("include_inactive") === "1";
      const funds = getSinkingFundsView(db, parsed.year, parsed.month, includeInactive);
      return ok(funds);
    }

    if (path === "/api/apply-templates" && req.method === "POST") {
      const parsed = parseYearMonth(params);
      if (!parsed) return bad("INVALID_INPUT", "Invalid year/month");
      getTemplates(db).forEach((tmpl) => applyTemplateToMonth(db, tmpl, parsed.year, parsed.month));
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok({ ok: true });
    }

    if (path === "/api/export/backup.json" && req.method === "GET") {
      const data = getData(db);
      return ok({
        app: "au-jour-le-jour",
        app_version: "web",
        schema_version: "1",
        exported_at: nowIsoLocal(),
        templates: data.templates,
        instances: data.instances,
        payment_events: data.payment_events,
        instance_events: data.instance_events,
        month_settings: data.month_settings,
        sinking_funds: data.sinking_funds,
        sinking_events: data.sinking_events,
        settings: data.settings,
      });
    }

    if (path === "/api/import/backup" && req.method === "POST") {
      const bodyRes = await parseJsonBody(req);
      if (!bodyRes.ok) return jsonResponse(400, { ok: false, error: bodyRes.error });
      const payload = bodyRes.body || {};
      if (!payload || typeof payload !== "object") return bad("INVALID_INPUT", "Invalid payload");
      const fresh = defaultDb();
      const data = getData(fresh);
      data.templates = Array.isArray(payload.templates) ? payload.templates : [];
      data.instances = Array.isArray(payload.instances) ? payload.instances : [];
      data.payment_events = Array.isArray(payload.payment_events) ? payload.payment_events : [];
      data.instance_events = Array.isArray(payload.instance_events) ? payload.instance_events : [];
      data.month_settings = Array.isArray(payload.month_settings) ? payload.month_settings : [];
      data.sinking_funds = Array.isArray(payload.sinking_funds) ? payload.sinking_funds : [];
      data.sinking_events = Array.isArray(payload.sinking_events) ? payload.sinking_events : [];
      data.settings = payload.settings && typeof payload.settings === "object"
        ? payload.settings
        : getSettings(fresh);
      const saved = safeSaveDb(fresh);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok({ imported: true });
    }

    if (path === "/api/export/month.csv" && req.method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return bad("INVALID_INPUT", "Invalid year/month");
      const rows = getInstancesForMonth(db, parsed.year, parsed.month);
      const csv = buildMonthCsv(rows);
      return new Response(csv, { status: 200, headers: { "Content-Type": "text/csv" } });
    }

    if (path === "/api/v1/summary" && req.method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return bad("INVALID_INPUT", "Invalid year/month");
      ensureMonth(db, parsed.year, parsed.month);
      autoContributeForMonth(db, parsed.year, parsed.month);
      const essentialsOnly = params.get("essentials_only") !== "false";
      const instances = getInstancesForMonth(db, parsed.year, parsed.month);
      const summary = computeSummary(instances, { year: parsed.year, month: parsed.month, essentialsOnly });
      const funds = getSinkingFundsView(db, parsed.year, parsed.month, false);
      const futureReserved = funds.reduce((sum, fund) => sum + Math.max(0, Number(fund.balance || 0)), 0);
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok({
        app: "au-jour-le-jour",
        app_version: "web",
        schema_version: "1",
        version: "web",
        period: `${parsed.year}-${pad2(parsed.month)}`,
        filters: { essentials_only: essentialsOnly },
        required_month: summary.required_month,
        paid_month: summary.paid_month,
        remaining_month: summary.remaining_month,
        need_daily_exact: summary.need_daily_exact,
        need_weekly_exact: summary.need_weekly_exact,
        free_for_month: summary.free_for_month,
        future_reserved: Number(futureReserved.toFixed(2)),
        generated_at: nowIsoLocal(),
      });
    }

    if (path === "/api/v1/month" && req.method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return bad("INVALID_INPUT", "Invalid year/month");
      ensureMonth(db, parsed.year, parsed.month);
      const essentialsOnly = params.get("essentials_only") !== "false";
      const instances = getInstancesForMonth(db, parsed.year, parsed.month);
      const filtered = essentialsOnly ? instances.filter((item) => item.essential_snapshot) : instances;
      const items = filtered.map((item) => ({
        instance_id: item.id,
        template_id: item.template_id,
        name: item.name_snapshot,
        category: item.category_snapshot || null,
        amount: Number(item.amount || 0),
        due_date: item.due_date,
        status: item.status,
        paid_date: item.paid_date || null,
        autopay: !!item.autopay_snapshot,
        essential: !!item.essential_snapshot,
        note: item.note || null,
      }));
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok({
        app: "au-jour-le-jour",
        app_version: "web",
        schema_version: "1",
        period: `${parsed.year}-${pad2(parsed.month)}`,
        items,
      });
    }

    if (path === "/api/v1/templates" && req.method === "GET") {
      const templates = getTemplates(db).slice();
      templates.sort((a, b) =>
        String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" })
      );
      return ok({ app: "au-jour-le-jour", app_version: "web", schema_version: "1", templates });
    }

    if (path === "/api/v1/actions" && req.method === "POST") {
      const bodyRes = await parseJsonBody(req);
      if (!bodyRes.ok) return jsonResponse(400, { ok: false, error: bodyRes.error });
      const action = bodyRes.body || {};
      const type = String(action.type || "").trim();
      if (!type) return bad("INVALID_INPUT", "type is required");
      let payload = { ok: true };
      if (type === "MARK_PAID" || type === "MARK_DONE") {
        const id = String(action.instance_id || "");
        if (!id) return bad("INVALID_INPUT", "instance_id is required");
        const instance = getInstances(db).find((inst) => inst.id === id);
        if (!instance) return bad("NOT_FOUND", "Instance not found", {}, 404);
        const payments = getPayments(db).filter((p) => p.instance_id === id);
        const amountPaid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
        const amountDue = Number(instance.amount || 0);
        const remaining = Math.max(0, amountDue - amountPaid);
        let paymentId = null;
        if (remaining > 0) {
          paymentId = uuid();
          getPayments(db).push({
            id: paymentId,
            instance_id: id,
            amount: remaining,
            paid_date: action.paid_date || todayDate(),
            created_at: new Date().toISOString(),
          });
        }
        instance.status = "paid";
        instance.paid_date = action.paid_date || todayDate();
        instance.updated_at = new Date().toISOString();
        logInstanceEvent(db, id, "marked_done", { paid_date: instance.paid_date, amount: amountDue, payment_id: paymentId });
        payload = { ok: true, instance: attachPayments(db, [instance])[0] };
      } else if (type === "MARK_PENDING") {
        const id = String(action.instance_id || "");
        if (!id) return bad("INVALID_INPUT", "instance_id is required");
        getData(db).payment_events = getPayments(db).filter((p) => p.instance_id !== id);
        const instance = getInstances(db).find((inst) => inst.id === id);
        if (instance) {
          instance.status = "pending";
          instance.paid_date = null;
          instance.updated_at = new Date().toISOString();
        }
        logInstanceEvent(db, id, "status_changed", { from: "paid", to: "pending" });
        payload = { ok: true, instance: instance ? attachPayments(db, [instance])[0] : null };
      } else if (type === "SKIP_INSTANCE") {
        const id = String(action.instance_id || "");
        if (!id) return bad("INVALID_INPUT", "instance_id is required");
        const instance = getInstances(db).find((inst) => inst.id === id);
        if (!instance) return bad("NOT_FOUND", "Instance not found", {}, 404);
        instance.status = "skipped";
        instance.paid_date = null;
        instance.updated_at = new Date().toISOString();
        logInstanceEvent(db, id, "skipped", { from: "pending", to: "skipped" });
        payload = { ok: true, instance: attachPayments(db, [instance])[0] };
      } else if (type === "UPDATE_INSTANCE_FIELDS") {
        const id = String(action.instance_id || "");
        if (!id) return bad("INVALID_INPUT", "instance_id is required");
        const instance = getInstances(db).find((inst) => inst.id === id);
        if (!instance) return bad("NOT_FOUND", "Instance not found", {}, 404);
        const before = { ...instance };
        const changes = {};
        let noteChange = null;
        if (action.amount !== undefined) {
          const amt = Number(action.amount);
          if (!Number.isFinite(amt) || amt < 0) return bad("INVALID_INPUT", "Amount must be >= 0");
          if (Number(before.amount || 0) !== amt) {
            changes.amount = { from: Number(before.amount || 0), to: amt };
          }
          instance.amount = amt;
        }
        if (action.due_date !== undefined) {
          const err = validateDateString(action.due_date);
          if (err) return bad("INVALID_INPUT", err);
          if (String(before.due_date || "") !== action.due_date) {
            changes.due_date = { from: before.due_date || "", to: action.due_date };
          }
          instance.due_date = action.due_date;
        }
        if (action.status !== undefined) {
          if (!["pending", "paid", "skipped"].includes(action.status)) return bad("INVALID_INPUT", "Invalid status");
          instance.status = action.status;
        }
        if (action.paid_date !== undefined) {
          const err = validateDateString(action.paid_date);
          if (err) return bad("INVALID_INPUT", err);
          instance.paid_date = action.paid_date;
        }
        if (action.note !== undefined) {
          if (String(before.note || "") !== String(action.note || "")) {
            noteChange = { from: before.note || "", to: action.note || "" };
          }
          instance.note = action.note || null;
        }
        if (action.name_snapshot !== undefined) {
          if (String(before.name_snapshot || "") !== String(action.name_snapshot || "")) {
            changes.name = { from: before.name_snapshot || "", to: action.name_snapshot || "" };
          }
          instance.name_snapshot = String(action.name_snapshot || "");
        }
        if (action.category_snapshot !== undefined) {
          if (String(before.category_snapshot || "") !== String(action.category_snapshot || "")) {
            changes.category = { from: before.category_snapshot || "", to: action.category_snapshot || "" };
          }
          instance.category_snapshot = action.category_snapshot || null;
        }
        instance.updated_at = new Date().toISOString();
        if (noteChange) {
          logInstanceEvent(db, id, "note_updated", noteChange);
        }
        const changeKeys = Object.keys(changes);
        if (changeKeys.length > 0) {
          logInstanceEvent(db, id, "edited", { changes });
        }
        payload = { ok: true, instance: attachPayments(db, [instance])[0] };
      } else if (type === "CREATE_TEMPLATE") {
        const name = String(action.name || "").trim();
        const amount = Number(action.amount_default);
        const dueDay = Number(action.due_day);
        if (!name) return bad("INVALID_INPUT", "Name is required");
        if (!Number.isFinite(amount) || amount < 0) return bad("INVALID_INPUT", "Amount must be >= 0");
        if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return bad("INVALID_INPUT", "Due day must be 1-31");
        const stamp = new Date().toISOString();
        const template = {
          id: uuid(),
          name,
          category: action.category || null,
          amount_default: amount,
          due_day: dueDay,
          autopay: !!action.autopay,
          essential: action.essential !== false,
          active: action.active !== false,
          default_note: action.default_note || null,
          match_payee_key: action.match_payee_key || null,
          match_amount_tolerance: Number(action.match_amount_tolerance || 0),
          created_at: stamp,
          updated_at: stamp,
        };
        getTemplates(db).push(template);
        const year = Number(action.year) || new Date().getFullYear();
        const month = Number(action.month) || new Date().getMonth() + 1;
        ensureMonth(db, year, month);
        payload = { ok: true, template };
      } else if (type === "UPDATE_TEMPLATE") {
        const id = String(action.template_id || action.id || "");
        if (!id) return bad("INVALID_INPUT", "template_id is required");
        const template = getTemplates(db).find((t) => t.id === id);
        if (!template) return bad("NOT_FOUND", "Template not found", {}, 404);
        template.name = action.name ?? template.name;
        template.category = action.category ?? template.category;
        template.amount_default = Number(action.amount_default ?? template.amount_default);
        template.due_day = Number(action.due_day ?? template.due_day);
        template.autopay = action.autopay ?? template.autopay;
        template.essential = action.essential ?? template.essential;
        template.active = action.active ?? template.active;
        template.default_note = action.default_note ?? template.default_note;
        template.match_payee_key = action.match_payee_key ?? template.match_payee_key;
        template.match_amount_tolerance = Number(action.match_amount_tolerance ?? template.match_amount_tolerance ?? 0);
        template.updated_at = new Date().toISOString();
        const year = Number(action.year);
        const month = Number(action.month);
        if (Number.isInteger(year) && Number.isInteger(month)) {
          applyTemplateToMonth(db, template, year, month);
        }
        payload = { ok: true, template };
      } else if (type === "ARCHIVE_TEMPLATE") {
        const id = String(action.template_id || "");
        if (!id) return bad("INVALID_INPUT", "template_id is required");
        const template = getTemplates(db).find((t) => t.id === id);
        if (!template) return bad("NOT_FOUND", "Template not found", {}, 404);
        template.active = false;
        template.updated_at = new Date().toISOString();
        payload = { ok: true };
      } else if (type === "DELETE_TEMPLATE") {
        const id = String(action.template_id || "");
        if (!id) return bad("INVALID_INPUT", "template_id is required");
        const year = Number(action.year);
        const month = Number(action.month);
        deleteTemplateFromMonth(db, id, year, month);
        payload = { ok: true };
      } else if (type === "APPLY_TEMPLATES") {
        const year = Number(action.year);
        const month = Number(action.month);
        if (!validYearMonth(year, month)) return bad("INVALID_INPUT", "year and month required");
        getTemplates(db).forEach((tmpl) => applyTemplateToMonth(db, tmpl, year, month));
        payload = { ok: true };
      } else if (type === "GENERATE_MONTH") {
        const year = Number(action.year);
        const month = Number(action.month);
        if (!validYearMonth(year, month)) return bad("INVALID_INPUT", "year and month required");
        ensureMonth(db, year, month);
        payload = { ok: true };
      } else {
        return bad("INVALID_INPUT", "Unknown action type");
      }
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok(payload);
    }

    if (path === "/api/chat") {
      if (req.method === "GET") return ok({ ok: true, items: [] });
      if (req.method === "POST") return ok({ ok: true });
      if (req.method === "DELETE") return ok({ ok: true });
    }

    return bad("NOT_FOUND", "Unknown endpoint", { path, method: req.method }, 404);
  }

  window.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url, window.location.origin);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req);
      } catch (err) {
        return jsonResponse(500, { ok: false, error: { code: "INTERNAL", message: "Unexpected error", details: {} } });
      }
    }
    return realFetch(input, init);
  };
})();
