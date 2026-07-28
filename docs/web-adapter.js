(() => {
  window.AJL_WEB_MODE = true;
  window.AJL_CAPABILITIES = Object.freeze({
    mode: "web",
    storage: "browser",
    assistant: false,
    offline: true,
    sharing: true,
    sharedHousehold: true,
    multiDevice: "relay",
    installable: true,
    portableBackup: true,
    janitor: false,
  });
  const DB_KEY = "AJL_WEB_DB_V1";
  const META_KEY = "AJL_WEB_META_V1";
  const MAX_BYTES = 4_500_000;
  const SHARE_BASE_URL = String(window.AJL_SHARE_BASE_URL || "https://agent.aujourlejour.xyz")
    .trim()
    .replace(/\/+$/, "");
  const SHARE_VIEWER_BASE_URL = String(window.AJL_SHARE_VIEWER_BASE_URL || window.location.origin || "")
    .trim()
    .replace(/\/+$/, "");
  const SHARE_OWNER_KEY = "ajl_share_owner_key";

  const realFetch = window.fetch.bind(window);

  if (typeof window.addEventListener === "function") {
    window.addEventListener("storage", (event) => {
      if (event.key !== DB_KEY || event.newValue === event.oldValue) return;
      if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("ajl:external-storage-update"));
      }
    });
  }

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
          defaults: {
            sort: "due_date",
            dueSoonDays: 7,
            defaultPeriod: "month",
            progressBasis: "auto",
            monthlyGoalAmount: 0,
            yearlyGoalAmount: 0,
            yearScope: "ytd",
            locale: "en-US",
            currency: "USD",
          },
          categories: [],
        },
      },
    };
  }

  function jsonResponse(status, payload) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }

  function ok(data, status = 200) {
    return jsonResponse(status, { ok: true, data });
  }

  function bad(code, message, details = {}, status = 400) {
    return jsonResponse(status, { ok: false, error: { code, message, details } });
  }

  function loadShareOwnerKey() {
    try {
      return localStorage.getItem(SHARE_OWNER_KEY) || "";
    } catch (err) {
      return "";
    }
  }

  function saveShareOwnerKey(key) {
    try {
      if (!key) localStorage.removeItem(SHARE_OWNER_KEY);
      else localStorage.setItem(SHARE_OWNER_KEY, String(key));
    } catch (err) {
      // ignore
    }
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

  function normalizeProgressBasis(value) {
    return String(value || "").toLowerCase() === "manual" ? "manual" : "auto";
  }

  function normalizeYearScope(value) {
    const raw = String(value || "").trim().toLowerCase();
    return raw === "full" || raw === "full year" ? "full" : "ytd";
  }

  function normalizeLocale(value) {
    const raw = String(value || "").trim();
    if (!raw) return "en-US";
    try {
      return Intl.getCanonicalLocales(raw)[0] || "en-US";
    } catch (err) {
      return "en-US";
    }
  }

  function normalizeCurrency(value) {
    const raw = String(value || "").trim().toUpperCase();
    return /^[A-Z]{3}$/.test(raw) ? raw : "USD";
  }

  function normalizeLedgerScope(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "personal") return "personal";
    if (raw === "shared") return "shared";
    return "all";
  }

  function getLedgerScopeLabel(scope) {
    const normalized = normalizeLedgerScope(scope);
    if (normalized === "personal") return "Personal only";
    if (normalized === "shared") return "Shared household";
    return "All bills";
  }

  function sanitizeGoalAmount(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return 0;
    return Number(amount.toFixed(2));
  }

  function normalizeSettingsDefaults(rawDefaults) {
    const defaults = rawDefaults && typeof rawDefaults === "object" ? rawDefaults : {};
    const allowedSort = new Set(["due_date", "amount", "name", "status"]);
    const sort = allowedSort.has(defaults.sort) ? defaults.sort : "due_date";
    let dueSoonDays = Number(defaults.dueSoonDays ?? 7);
    if (!Number.isFinite(dueSoonDays) || dueSoonDays < 1 || dueSoonDays > 31) {
      dueSoonDays = 7;
    }
    return {
      sort,
      dueSoonDays: Math.round(dueSoonDays),
      defaultPeriod: "month",
      progressBasis: normalizeProgressBasis(defaults.progressBasis),
      monthlyGoalAmount: sanitizeGoalAmount(defaults.monthlyGoalAmount),
      yearlyGoalAmount: sanitizeGoalAmount(defaults.yearlyGoalAmount),
      yearScope: normalizeYearScope(defaults.yearScope),
      locale: normalizeLocale(defaults.locale),
      currency: normalizeCurrency(defaults.currency),
    };
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

  function diffDays(dateA, dateB) {
    const first = new Date(`${dateA}T00:00:00`);
    const second = new Date(`${dateB}T00:00:00`);
    if (Number.isNaN(first.valueOf()) || Number.isNaN(second.valueOf())) return 0;
    return Math.round((first - second) / 86400000);
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

  function roundMoney(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Number(num.toFixed(2));
  }

  function formatMoney(value, settings) {
    const defaults = (settings && settings.defaults) || normalizeSettingsDefaults({});
    try {
      return new Intl.NumberFormat(defaults.locale || "en-US", {
        style: "currency",
        currency: defaults.currency || "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(roundMoney(value));
    } catch (err) {
      return `$${roundMoney(value).toFixed(2)}`;
    }
  }

  function buildProjectedInstancesFromTemplates(templates, year, month) {
    return templates
      .filter((template) => template.active !== false)
      .map((template) => {
        const dueDay = clampDueDay(year, month, Number(template.due_day || 1));
        const amount = Number(template.amount_default || 0);
        return {
          id: `projected:${template.id}:${year}-${pad2(month)}`,
          template_id: template.id,
          year,
          month,
          name_snapshot: template.name,
          category_snapshot: template.category || null,
          amount,
          due_date: toDateString(year, month, dueDay),
          autopay_snapshot: !!template.autopay,
          essential_snapshot: template.essential !== false,
          shared_household_snapshot: !!template.shared_household,
          status: "pending",
          status_derived: "pending",
          amount_paid: 0,
          amount_remaining: amount,
        };
      });
  }

  function getProgressInstancesForMonth(db, year, month, templates) {
    const rows = getInstances(db).filter((inst) => inst.year === year && inst.month === month);
    if (rows.length > 0) return attachPayments(db, rows);
    return buildProjectedInstancesFromTemplates(templates, year, month);
  }

  function filterLedgerScopeRows(rows, scope) {
    const normalized = normalizeLedgerScope(scope);
    if (normalized === "all") return Array.isArray(rows) ? rows : [];
    return (Array.isArray(rows) ? rows : []).filter((item) => {
      const shared = !!(item && (item.shared_household_snapshot || item.shared_household));
      return normalized === "shared" ? shared : !shared;
    });
  }

  function computeProgressTotals(instances, essentialsOnly) {
    const list = essentialsOnly ? instances.filter((item) => item.essential_snapshot) : instances;
    const required = list
      .filter((item) => item.status_derived !== "skipped")
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const done = list
      .filter((item) => item.status_derived !== "skipped")
      .reduce((sum, item) => {
        const due = Number(item.amount || 0);
        const paid = Number(item.amount_paid || 0);
        return sum + Math.min(due, paid);
      }, 0);
    const remaining = list
      .filter((item) => item.status_derived !== "skipped")
      .reduce((sum, item) => sum + Number(item.amount_remaining || 0), 0);
    return {
      required: roundMoney(required),
      done: roundMoney(done),
      remaining: roundMoney(remaining),
    };
  }

  function monthIndex(year, month) {
    return year * 12 + (month - 1);
  }

  function getLastNMonths(year, month, count) {
    const total = Math.max(1, Number(count) || 1);
    const months = [];
    let y = year;
    let m = month;
    for (let i = 0; i < total; i += 1) {
      months.unshift({ year: y, month: m });
      m -= 1;
      if (m < 1) {
        m = 12;
        y -= 1;
      }
    }
    return months;
  }

  function computeBehaviorFeatures(db, year, month, windowSize) {
    const months = getLastNMonths(year, month, windowSize);
    const indices = months.map((m) => monthIndex(m.year, m.month));
    const minIndex = Math.min(...indices);
    const maxIndex = Math.max(...indices);
    const scopedInstances = getInstances(db).filter((inst) => {
      const idx = monthIndex(Number(inst.year || 0), Number(inst.month || 0));
      return idx >= minIndex && idx <= maxIndex;
    });

    const scopedIds = new Set(scopedInstances.map((inst) => inst.id));
    const paymentTotals = new Map();
    const paymentDates = new Map();
    getPayments(db).forEach((payment) => {
      if (!scopedIds.has(payment.instance_id)) return;
      paymentTotals.set(
        payment.instance_id,
        Number(paymentTotals.get(payment.instance_id) || 0) + Number(payment.amount || 0)
      );
      const currentDate = String(paymentDates.get(payment.instance_id) || "");
      const nextDate = String(payment.paid_date || "");
      if (!currentDate || nextDate > currentDate) {
        paymentDates.set(payment.instance_id, nextDate);
      }
    });

    const templateStats = new Map();
    const perMonthRanks = new Map();
    const monthKey = (y, m) => `${y}-${pad2(m)}`;

    scopedInstances.forEach((inst) => {
      const templateId = inst.template_id;
      const totalPaid = Number(paymentTotals.get(inst.id) || 0);
      const lastDate = paymentDates.get(inst.id) || null;
      if (!templateStats.has(templateId)) {
        templateStats.set(templateId, {
          template_id: templateId,
          name: inst.name_snapshot,
          category: inst.category_snapshot || null,
          total_instances: 0,
          paid_instances: 0,
          on_time_paid: 0,
          late_paid: 0,
          sum_offset: 0,
          offset_count: 0,
          rank_sum: 0,
          rank_count: 0,
          per_month_paid: new Map(),
        });
      }

      const stat = templateStats.get(templateId);
      stat.total_instances += 1;
      const paidFlag = totalPaid >= Number(inst.amount || 0) && Number(inst.amount || 0) > 0;
      const periodKey = monthKey(inst.year, inst.month);
      stat.per_month_paid.set(periodKey, paidFlag);

      if (paidFlag && lastDate) {
        stat.paid_instances += 1;
        const offset = diffDays(lastDate, inst.due_date);
        stat.sum_offset += offset;
        stat.offset_count += 1;
        if (offset <= 0) stat.on_time_paid += 1;
        if (offset > 0) stat.late_paid += 1;
      }

      if (lastDate) {
        const list = perMonthRanks.get(periodKey) || [];
        list.push({ template_id: templateId, last_date: lastDate });
        perMonthRanks.set(periodKey, list);
      }
    });

    perMonthRanks.forEach((list) => {
      list.sort((a, b) => String(a.last_date).localeCompare(String(b.last_date)));
      list.forEach((entry, index) => {
        const stat = templateStats.get(entry.template_id);
        if (!stat) return;
        stat.rank_sum += index + 1;
        stat.rank_count += 1;
      });
    });

    const lastThree = getLastNMonths(year, month, 3).map((m) => monthKey(m.year, m.month));
    const perBill = Array.from(templateStats.values()).map((stat) => {
      const avgOffset = stat.offset_count ? stat.sum_offset / stat.offset_count : 0;
      const onTimeRate = stat.paid_instances ? stat.on_time_paid / stat.paid_instances : 0;
      const lateRate = stat.paid_instances ? stat.late_paid / stat.paid_instances : 0;
      const consistency = stat.total_instances ? stat.paid_instances / stat.total_instances : 0;
      const typicalRank = stat.rank_count ? stat.rank_sum / stat.rank_count : null;
      const lastFlags = lastThree.map((key) => stat.per_month_paid.get(key) || false);
      return {
        template_id: stat.template_id,
        name: stat.name,
        category: stat.category,
        avg_pay_day_offset: roundMoney(avgOffset),
        on_time_rate: roundMoney(onTimeRate),
        typical_payment_order_rank: typicalRank ? roundMoney(typicalRank) : null,
        last_3_months_paid_flag: lastFlags,
        payment_consistency_score: roundMoney(consistency),
        lateness_trend: roundMoney(lateRate),
        typical_pay_window_days: stat.offset_count ? roundMoney(Math.abs(avgOffset)) : null,
      };
    });

    const currentInstances = getInstancesForMonth(db, year, month);
    const essentials = currentInstances.filter((inst) => inst.essential_snapshot);
    const essentialsRequired = essentials
      .filter((inst) => inst.status_derived !== "skipped")
      .reduce((sum, inst) => sum + Number(inst.amount || 0), 0);
    const essentialsPaid = essentials
      .filter((inst) => inst.status_derived !== "skipped")
      .reduce((sum, inst) => sum + Math.min(Number(inst.amount || 0), Number(inst.amount_paid || 0)), 0);
    const percentEssentialsPaid = essentialsRequired
      ? roundMoney(essentialsPaid / essentialsRequired)
      : 0;

    const today = todayDate();
    const nextDue = currentInstances
      .filter((inst) => inst.status_derived !== "skipped" && Number(inst.amount_remaining || 0) > 0)
      .map((inst) => diffDays(inst.due_date, today))
      .filter((diff) => diff >= 0)
      .sort((a, b) => a - b)[0];

    const summary = computeSummary(currentInstances, {
      year,
      month,
      essentialsOnly: true,
    });

    return {
      global: {
        percent_essentials_paid: percentEssentialsPaid,
        days_until_next_due: Number.isFinite(nextDue) ? nextDue : null,
        current_free_for_month_flag: summary.free_for_month,
      },
      per_bill: perBill,
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
      return {
        defaults: normalizeSettingsDefaults({}),
        categories: [],
        share_base_url: SHARE_BASE_URL,
        share_viewer_base_url: SHARE_VIEWER_BASE_URL,
        firstRunCompleted: false,
        hasCompletedOnboarding: false,
      };
    }
    return {
      defaults: normalizeSettingsDefaults(settings.defaults || {}),
      categories: Array.isArray(settings.categories) ? settings.categories.filter(Boolean) : [],
      share_base_url: SHARE_BASE_URL,
      share_viewer_base_url: SHARE_VIEWER_BASE_URL,
      firstRunCompleted: settings.firstRunCompleted === true,
      hasCompletedOnboarding: settings.hasCompletedOnboarding === true || settings.firstRunCompleted === true,
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
        shared_household_snapshot: !!template.shared_household,
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


  function parseYearOnly(value, fallbackYear) {
    const year = Number(value ?? fallbackYear);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
    return year;
  }

  function buildTemplateProjection(template, year, month) {
    const dueDay = clampDueDay(year, month, Number(template.due_day || 1));
    const amount = Number(template.amount_default || 0);
    return {
      id: "projected:" + template.id + ":" + year + "-" + pad2(month),
      template_id: template.id,
      year,
      month,
      name_snapshot: template.name,
      category_snapshot: template.category || null,
      amount,
      due_date: toDateString(year, month, dueDay),
      autopay_snapshot: !!template.autopay,
      essential_snapshot: template.essential !== false,
      shared_household_snapshot: !!template.shared_household,
      status: "pending",
      status_derived: "pending",
      amount_paid: 0,
      amount_remaining: amount,
      projected: true,
    };
  }

  function buildInstanceYearBreakdown(db, instanceId, year) {
    const source = getInstances(db).find((inst) => inst.id === instanceId);
    if (!source) return null;
    const template = source.template_id ? getTemplates(db).find((tmpl) => tmpl.id === source.template_id) : null;
    const rows = getInstances(db).filter((inst) => {
      if (source.template_id) return inst.template_id === source.template_id && inst.year === year;
      return inst.id === instanceId && inst.year === year;
    });
    const attached = attachPayments(db, rows);
    const byMonth = new Map(attached.map((row) => [Number(row.month), row]));
    const months = [];
    let amountDueYear = 0;
    let amountPaidYear = 0;
    let amountRemainingYear = 0;
    let monthsScheduled = 0;
    let monthsPaidOff = 0;
    let nextOpenMonth = null;

    for (let month = 1; month <= 12; month += 1) {
      let row = byMonth.get(month) || null;
      const projected = !row && template && template.active !== false;
      if (projected) row = buildTemplateProjection(template, year, month);
      const scheduled = Boolean(row);
      const amount = scheduled ? Number(row.amount || 0) : 0;
      const amountPaid = scheduled ? Number(row.amount_paid || 0) : 0;
      const amountRemaining = scheduled ? Number(row.amount_remaining || Math.max(0, amount - amountPaid)) : 0;
      const status = scheduled ? String(row.status_derived || row.status || "pending") : "unscheduled";
      const billCounts = scheduled && status !== "skipped";
      const paidOff = billCounts && amountRemaining <= 0;
      if (billCounts) {
        monthsScheduled += 1;
        amountDueYear += amount;
        amountPaidYear += amountPaid;
        amountRemainingYear += amountRemaining;
        if (paidOff) monthsPaidOff += 1;
        if (!paidOff && nextOpenMonth === null) nextOpenMonth = month;
      }
      months.push({
        month,
        period: year + "-" + pad2(month),
        instance_id: scheduled && !row.projected ? row.id : null,
        template_id: source.template_id || null,
        scheduled,
        projected: Boolean(projected),
        amount: roundMoney(amount),
        amount_paid: roundMoney(amountPaid),
        amount_remaining: roundMoney(amountRemaining),
        due_date: scheduled ? row.due_date || null : null,
        status,
        paid_off: paidOff,
      });
    }

    return {
      instance_id: source.id,
      template_id: source.template_id || null,
      name: source.name_snapshot,
      category: source.category_snapshot || null,
      year,
      amount_due_year: roundMoney(amountDueYear),
      amount_paid_year: roundMoney(amountPaidYear),
      amount_remaining_year: roundMoney(amountRemainingYear),
      months_scheduled: monthsScheduled,
      months_paid_off: monthsPaidOff,
      next_open_month: nextOpenMonth,
      months,
    };
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
    instance.shared_household_snapshot = !!template.shared_household;
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


  function escapePdfText(value) {
    return String(value || "")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  function wrapPdfLine(text, maxLength = 92) {
    const raw = String(text || "").trim();
    if (!raw) return [""];
    if (raw.length <= maxLength) return [raw];
    const words = raw.split(/\s+/);
    const lines = [];
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length <= maxLength) {
        current = next;
        continue;
      }
      if (current) lines.push(current);
      if (word.length > maxLength) {
        lines.push(word.slice(0, maxLength));
        current = word.slice(maxLength);
      } else {
        current = word;
      }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [raw.slice(0, maxLength)];
  }

  function buildReceiptPdf(pages) {
    const encoder = new TextEncoder();
    const pageLines = Array.isArray(pages) && pages.length > 0 ? pages : [[]];
    const pageCount = pageLines.length;
    const fontObjectNum = pageCount * 2 + 3;
    const objectCount = fontObjectNum;
    const objects = new Array(objectCount + 1).fill(null);
    const pageRefs = [];

    for (let i = 0; i < pageCount; i += 1) {
      const pageObjectNum = 3 + i * 2;
      const contentObjectNum = 4 + i * 2;
      pageRefs.push(`${pageObjectNum} 0 R`);
      const contentRows = [];
      contentRows.push("BT");
      contentRows.push("/F1 11 Tf");
      contentRows.push("14 TL");
      contentRows.push("50 770 Td");
      const lines = Array.isArray(pageLines[i]) ? pageLines[i] : [];
      if (lines.length === 0) {
        contentRows.push(`(${escapePdfText("Receipt has no line items.")}) Tj`);
      } else {
        for (let idx = 0; idx < lines.length; idx += 1) {
          const text = escapePdfText(lines[idx]);
          if (idx === 0) contentRows.push(`(${text}) Tj`);
          else contentRows.push(`T* (${text}) Tj`);
        }
      }
      contentRows.push("ET");
      const stream = `${contentRows.join("\n")}\n`;
      const length = encoder.encode(stream).length;
      objects[contentObjectNum] = `<< /Length ${length} >>\nstream\n${stream}endstream`;
      objects[pageObjectNum] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontObjectNum} 0 R >> >> ` +
        `/Contents ${contentObjectNum} 0 R >>`;
    }

    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${pageRefs.join(" ")}] >>`;
    objects[fontObjectNum] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

    let body = "%PDF-1.4\n";
    const offsets = new Array(objectCount + 1).fill(0);
    for (let i = 1; i <= objectCount; i += 1) {
      const objectBody = objects[i] || "";
      offsets[i] = encoder.encode(body).length;
      body += `${i} 0 obj\n${objectBody}\nendobj\n`;
    }
    const xrefPos = encoder.encode(body).length;
    body += `xref\n0 ${objectCount + 1}\n`;
    body += "0000000000 65535 f \n";
    for (let i = 1; i <= objectCount; i += 1) {
      body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    body += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
    return encoder.encode(body);
  }

  async function handleApi(req) {
    const url = new URL(req.url, window.location.origin);
    const path = url.pathname;
    const params = url.searchParams;

    const init = ensureDbInitialized();
    if (!init.ok) return jsonResponse(500, { ok: false, error: init.error });
    const db = init.db;

    if (path === "/api/health" && req.method === "GET") {
      return ok({
        app: "au-jour-le-jour",
        mode: "web",
        app_version: "web",
        schema_version: String(db.schemaVersion),
        storage: "localStorage",
        schemaVersion: db.schemaVersion,
      });
    }

    if (path.startsWith("/api/shares")) {
      if (!SHARE_BASE_URL) {
        return jsonResponse(503, {
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "Sharing service is not configured.",
            details: {},
          },
        });
      }
      try {
        const target = new URL(`${path}${url.search}`, SHARE_BASE_URL);
        const headers = new Headers();
        const incomingOwner = req.headers.get("x-ajl-share-owner");
        const isPublicLookup = /^\/api\/shares\/[A-Za-z0-9_-]{24,128}$/.test(path);
        const ownerKey = isPublicLookup ? null : incomingOwner || loadShareOwnerKey();
        if (ownerKey) headers.set("X-AJL-Share-Owner", ownerKey);
        const contentType = req.headers.get("content-type");
        if (contentType) headers.set("Content-Type", contentType);
        const bodyText = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
        const relayRes = await realFetch(target.toString(), {
          method: req.method,
          headers,
          body: bodyText,
        });
        const relayContentType = relayRes.headers.get("content-type") || "";
        const relayBodyText = await relayRes.text();
        if (relayContentType.includes("application/json")) {
          const parsed = safeParse(relayBodyText);
          if (parsed.ok && parsed.value && typeof parsed.value === "object") {
            const ownerFromResponse =
              parsed.value.ownerKey ||
              parsed.value.manageKey ||
              parsed.value.owner_key ||
              parsed.value?.share?.ownerKey ||
              parsed.value?.share?.manageKey ||
              parsed.value?.share?.owner_key ||
              null;
            if (ownerFromResponse) saveShareOwnerKey(ownerFromResponse);
          }
        }
        return new Response(relayBodyText, {
          status: relayRes.status,
          headers: {
            "Content-Type": relayContentType || "application/json",
            "Cache-Control": "no-store",
          },
        });
      } catch (err) {
        return jsonResponse(503, {
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "Share relay is unavailable.",
            details: {},
          },
        });
      }
    }

    if (path === "/api/qr") {
      if (!SHARE_BASE_URL) {
        return jsonResponse(503, {
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "QR service is not configured.",
            details: {},
          },
        });
      }
      try {
        const target = new URL(`${path}${url.search}`, SHARE_BASE_URL);
        const relayRes = await realFetch(target.toString(), {
          method: req.method,
          headers: req.headers,
        });
        const relayContentType = relayRes.headers.get("content-type") || "image/svg+xml";
        const relayBodyText = await relayRes.text();
        return new Response(relayBodyText, {
          status: relayRes.status,
          headers: {
            "Content-Type": relayContentType,
            "Cache-Control": "no-store",
          },
        });
      } catch (err) {
        return jsonResponse(503, {
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "QR relay is unavailable.",
            details: {},
          },
        });
      }
    }

    if (path.startsWith("/api/households")) {
      if (!SHARE_BASE_URL) {
        return jsonResponse(503, {
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "Shared household service is not configured.",
            details: {},
          },
        });
      }
      try {
        const target = new URL(`${path}${url.search}`, SHARE_BASE_URL);
        const headers = new Headers();
        const ownerHeader = req.headers.get("x-ajl-household-owner");
        const memberHeader = req.headers.get("x-ajl-household-member");
        if (ownerHeader) headers.set("X-AJL-Household-Owner", ownerHeader);
        if (memberHeader) headers.set("X-AJL-Household-Member", memberHeader);
        const contentType = req.headers.get("content-type");
        if (contentType) headers.set("Content-Type", contentType);
        const bodyText = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
        const relayRes = await realFetch(target.toString(), {
          method: req.method,
          headers,
          body: bodyText,
        });
        const relayContentType = relayRes.headers.get("content-type") || "";
        const relayBodyText = await relayRes.text();
        return new Response(relayBodyText, {
          status: relayRes.status,
          headers: {
            "Content-Type": relayContentType || "application/json",
            "Cache-Control": "no-store",
          },
        });
      } catch (err) {
        return jsonResponse(503, {
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "Shared household relay is unavailable.",
            details: {},
          },
        });
      }
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
      const categories = Array.isArray(body.categories)
        ? body.categories.map((c) => String(c || "").trim()).filter(Boolean)
        : [];
      getData(db).settings = {
        defaults: normalizeSettingsDefaults(body.defaults || {}),
        categories,
        firstRunCompleted: body.firstRunCompleted === true,
        hasCompletedOnboarding:
          body.hasCompletedOnboarding === true || body.firstRunCompleted === true,
      };
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok(getSettings(db));
    }

    if (path === "/api/progress" && req.method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return bad("INVALID_INPUT", "Invalid year/month");
      const settings = getSettings(db);
      const defaults = settings.defaults || normalizeSettingsDefaults({});
      const basis = normalizeProgressBasis(defaults.progressBasis);
      const yearScope = normalizeYearScope(params.get("year_scope") || defaults.yearScope);
      const essentialsOnly = params.get("essentials_only") !== "false";
      const templates = getTemplates(db).filter((template) => template.active !== false);

      const monthRows = getProgressInstancesForMonth(
        db,
        parsed.year,
        parsed.month,
        templates
      );
      const monthTotals = computeProgressTotals(monthRows, essentialsOnly);

      const monthStart = 1;
      const monthEnd = yearScope === "full" ? 12 : parsed.month;
      let yearRequired = 0;
      let yearDoneScope = 0;
      let yearRemaining = 0;
      let yearDoneOutsideScope = 0;
      for (let m = monthStart; m <= 12; m += 1) {
        const rows = getProgressInstancesForMonth(db, parsed.year, m, templates);
        const totals = computeProgressTotals(rows, essentialsOnly);
        if (m <= monthEnd) {
          yearRequired += totals.required;
          yearDoneScope += totals.done;
          yearRemaining += totals.remaining;
        } else {
          yearDoneOutsideScope += totals.done;
        }
      }
      const yearTotals = {
        required: roundMoney(yearRequired),
        done: roundMoney(yearDoneScope + yearDoneOutsideScope),
        remaining: roundMoney(yearRemaining),
      };

      let monthTarget = monthTotals.required;
      let yearTarget = yearTotals.required;
      if (basis === "manual") {
        if (defaults.monthlyGoalAmount > 0) {
          monthTarget = roundMoney(defaults.monthlyGoalAmount);
        }
        if (defaults.yearlyGoalAmount > 0) {
          yearTarget = roundMoney(defaults.yearlyGoalAmount);
        } else if (defaults.monthlyGoalAmount > 0) {
          yearTarget = roundMoney(defaults.monthlyGoalAmount * monthEnd);
        }
      }
      const monthPercent = monthTarget > 0 ? (monthTotals.done / monthTarget) * 100 : 0;
      const yearPercent = yearTarget > 0 ? (yearTotals.done / yearTarget) * 100 : 0;

      return ok({
        period: `${parsed.year}-${pad2(parsed.month)}`,
        basis,
        year_scope: yearScope,
        essentials_only: essentialsOnly,
        month: {
          required: monthTotals.required,
          done: monthTotals.done,
          remaining: monthTotals.remaining,
          target: roundMoney(monthTarget),
          target_remaining: roundMoney(Math.max(0, monthTarget - monthTotals.done)),
          percent: roundMoney(monthPercent),
        },
        year: {
          required: yearTotals.required,
          done: yearTotals.done,
          remaining: yearTotals.remaining,
          target: roundMoney(yearTarget),
          target_remaining: roundMoney(Math.max(0, yearTarget - yearTotals.done)),
          percent: roundMoney(yearPercent),
          prepaid_future_done: roundMoney(yearDoneOutsideScope),
          months_in_scope: monthEnd,
          start_month: monthStart,
          end_month: monthEnd,
        },
      });
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
        shared_household: !!body.shared_household,
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
      template.shared_household = body.shared_household === undefined ? !!template.shared_household : !!body.shared_household;
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

    if (path.startsWith("/api/instances/") && path.endsWith("/year-breakdown") && req.method === "GET") {
      const id = path.split("/")[3];
      if (!id) return bad("INVALID_INPUT", "Invalid id");
      const source = getInstances(db).find((inst) => inst.id === id);
      if (!source) return bad("NOT_FOUND", "Instance not found", {}, 404);
      const year = parseYearOnly(params.get("year"), source.year);
      if (!year) return bad("INVALID_INPUT", "Invalid year");
      const summary = buildInstanceYearBreakdown(db, id, year);
      if (!summary) return bad("NOT_FOUND", "Instance not found", {}, 404);
      return ok(summary);
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

    if (path === "/api/month-settings" && req.method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return bad("INVALID_INPUT", "Invalid year/month");
      const row = getMonthSettings(db).find(
        (entry) => Number(entry.year) === parsed.year && Number(entry.month) === parsed.month
      );
      return ok({
        year: parsed.year,
        month: parsed.month,
        cash_start: roundMoney(row?.cash_start || 0),
        available_now: roundMoney(row?.available_now || 0),
      });
    }

    if (path === "/api/month-settings" && req.method === "POST") {
      const bodyRes = await parseJsonBody(req);
      if (!bodyRes.ok) return jsonResponse(400, { ok: false, error: bodyRes.error });
      const body = bodyRes.body || {};
      const year = Number(body.year);
      const month = Number(body.month);
      if (!validYearMonth(year, month)) return bad("INVALID_INPUT", "Invalid year/month");
      const rows = getMonthSettings(db);
      const existing =
        rows.find((entry) => Number(entry.year) === year && Number(entry.month) === month) || null;
      const cashStart =
        body.cash_start !== undefined ? Number(body.cash_start) : Number(existing?.cash_start || 0);
      const availableNow =
        body.available_now !== undefined
          ? Number(body.available_now)
          : Number(existing?.available_now || 0);
      if (!Number.isFinite(cashStart) || cashStart < 0) {
        return bad("INVALID_INPUT", "cash_start must be >= 0");
      }
      if (!Number.isFinite(availableNow) || availableNow < 0) {
        return bad("INVALID_INPUT", "available_now must be >= 0");
      }
      const nextRow = {
        year,
        month,
        cash_start: roundMoney(cashStart),
        available_now: roundMoney(availableNow),
        updated_at: new Date().toISOString(),
      };
      if (existing) {
        existing.cash_start = nextRow.cash_start;
        existing.available_now = nextRow.available_now;
        existing.updated_at = nextRow.updated_at;
      } else {
        rows.push(nextRow);
      }
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok(nextRow);
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
      const settings = getSettings(db);
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
        settings: {
          defaults: normalizeSettingsDefaults(settings.defaults || {}),
          categories: Array.isArray(settings.categories) ? settings.categories : [],
          firstRunCompleted: settings.firstRunCompleted === true,
          hasCompletedOnboarding:
            settings.hasCompletedOnboarding === true || settings.firstRunCompleted === true,
        },
      });
    }

    if (path === "/api/import/backup/preview" && req.method === "POST") {
      const bodyRes = await parseJsonBody(req);
      if (!bodyRes.ok) return jsonResponse(400, { ok: false, error: bodyRes.error });
      const payload = bodyRes.body || {};
      const existingTemplateIds = new Set(getTemplates(db).map((row) => String(row.id)));
      const existingInstanceIds = new Set(getInstances(db).map((row) => String(row.id)));
      const existingPaymentIds = new Set(getPayments(db).map((row) => String(row.id)));
      const existingEventIds = new Set(getInstanceEvents(db).map((row) => String(row.id)));
      const existingFundIds = new Set(getSinkingFunds(db).map((row) => String(row.id)));
      const existingSinkingEventIds = new Set(getSinkingEvents(db).map((row) => String(row.id)));
      const templates = Array.isArray(payload.templates) ? payload.templates : [];
      const instances = Array.isArray(payload.instances) ? payload.instances : [];
      const payments = Array.isArray(payload.payment_events) ? payload.payment_events : [];
      const instanceEvents = Array.isArray(payload.instance_events) ? payload.instance_events : [];
      const monthSettings = Array.isArray(payload.month_settings) ? payload.month_settings : [];
      const sinkingFunds = Array.isArray(payload.sinking_funds) ? payload.sinking_funds : [];
      const sinkingEvents = Array.isArray(payload.sinking_events) ? payload.sinking_events : [];
      return ok({
        ok: true,
        dry_run: true,
        templates: {
          incoming: templates.length,
          add: templates.filter((row) => row?.name && !existingTemplateIds.has(String(row.id || ""))).length,
          duplicate: templates.filter((row) => row?.id && existingTemplateIds.has(String(row.id))).length,
          conflict: 0,
          skipped: templates.filter((row) => !row?.name).length,
        },
        instances: {
          incoming: instances.length,
          add: instances.filter((row) => row?.id && !existingInstanceIds.has(String(row.id))).length,
          duplicate: instances.filter((row) => row?.id && existingInstanceIds.has(String(row.id))).length,
          skipped: instances.filter((row) => !row?.id || !validYearMonth(Number(row.year), Number(row.month))).length,
        },
        payment_events: {
          incoming: payments.length,
          add: payments.filter((row) => row?.id && row?.instance_id && !existingPaymentIds.has(String(row.id))).length,
          duplicate: payments.filter((row) => row?.id && existingPaymentIds.has(String(row.id))).length,
          skipped: payments.filter((row) => !row?.id || !row?.instance_id || Number(row.amount) <= 0).length,
        },
        instance_events: {
          incoming: instanceEvents.length,
          add: instanceEvents.filter((row) => row?.id && row?.instance_id && !existingEventIds.has(String(row.id))).length,
          duplicate: instanceEvents.filter((row) => row?.id && existingEventIds.has(String(row.id))).length,
          skipped: instanceEvents.filter((row) => !row?.id || !row?.instance_id).length,
        },
        month_settings: {
          incoming: monthSettings.length,
          upsert: monthSettings.filter((row) => validYearMonth(Number(row.year), Number(row.month))).length,
          skipped: monthSettings.filter((row) => !validYearMonth(Number(row.year), Number(row.month))).length,
        },
        sinking_funds: {
          incoming: sinkingFunds.length,
          add: sinkingFunds.filter((row) => row?.id && !existingFundIds.has(String(row.id))).length,
          duplicate: sinkingFunds.filter((row) => row?.id && existingFundIds.has(String(row.id))).length,
          skipped: sinkingFunds.filter((row) => !row?.id || Number(row.target_amount) < 0).length,
        },
        sinking_events: {
          incoming: sinkingEvents.length,
          add: sinkingEvents.filter((row) => row?.id && row?.fund_id && !existingSinkingEventIds.has(String(row.id))).length,
          duplicate: sinkingEvents.filter((row) => row?.id && existingSinkingEventIds.has(String(row.id))).length,
          skipped: sinkingEvents.filter((row) => !row?.id || !row?.fund_id || Number(row.amount) < 0).length,
        },
        settings: { present: !!(payload.settings && typeof payload.settings === "object") },
        warnings: [],
      });
    }

    if (path === "/api/import/backup" && req.method === "POST") {
      const bodyRes = await parseJsonBody(req);
      if (!bodyRes.ok) return jsonResponse(400, { ok: false, error: bodyRes.error });
      const payload = bodyRes.body || {};
      if (!payload || typeof payload !== "object") return bad("INVALID_INPUT", "Invalid payload");
      if (
        payload.schema_version !== undefined &&
        String(payload.schema_version) !== "1"
      ) {
        return bad(
          "INVALID_INPUT",
          "Unsupported schema_version",
          { schema_version: payload.schema_version }
        );
      }
      const listFields = [
        "templates",
        "instances",
        "payment_events",
        "instance_events",
        "month_settings",
        "sinking_funds",
        "sinking_events",
      ];
      for (const field of listFields) {
        if (payload[field] !== undefined && !Array.isArray(payload[field])) {
          return bad("INVALID_INPUT", `Invalid ${field} payload`);
        }
      }
      const fresh = defaultDb();
      const data = getData(fresh);
      data.templates = Array.isArray(payload.templates) ? payload.templates : [];
      data.instances = Array.isArray(payload.instances) ? payload.instances : [];
      data.payment_events = Array.isArray(payload.payment_events) ? payload.payment_events : [];
      data.instance_events = Array.isArray(payload.instance_events) ? payload.instance_events : [];
      data.month_settings = Array.isArray(payload.month_settings) ? payload.month_settings : [];
      data.sinking_funds = Array.isArray(payload.sinking_funds) ? payload.sinking_funds : [];
      data.sinking_events = Array.isArray(payload.sinking_events) ? payload.sinking_events : [];
      if (payload.settings && typeof payload.settings === "object") {
        const incomingSettings = payload.settings;
        data.settings = {
          defaults: normalizeSettingsDefaults(incomingSettings.defaults || {}),
          categories: Array.isArray(incomingSettings.categories)
            ? incomingSettings.categories.map((c) => String(c || "").trim()).filter(Boolean)
            : [],
          firstRunCompleted: incomingSettings.firstRunCompleted === true,
          hasCompletedOnboarding:
            incomingSettings.hasCompletedOnboarding === true ||
            incomingSettings.firstRunCompleted === true,
        };
      } else {
        const normalized = getSettings(fresh);
        data.settings = {
          defaults: normalizeSettingsDefaults(normalized.defaults || {}),
          categories: Array.isArray(normalized.categories) ? normalized.categories : [],
          firstRunCompleted: normalized.firstRunCompleted === true,
          hasCompletedOnboarding:
            normalized.hasCompletedOnboarding === true ||
            normalized.firstRunCompleted === true,
        };
      }
      const saved = safeSaveDb(fresh);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok({ imported: true });
    }

    if (path === "/api/export/receipt.pdf" && req.method === "GET") {
      const now = new Date();
      const yearRaw = Number(params.get("year") || now.getFullYear());
      if (!Number.isInteger(yearRaw) || yearRaw < 2000 || yearRaw > 2100) {
        return bad("INVALID_INPUT", "Invalid year");
      }
      const monthRaw = Number(params.get("month") || now.getMonth() + 1);
      const month = Number.isInteger(monthRaw) && monthRaw >= 1 && monthRaw <= 12
        ? monthRaw
        : now.getMonth() + 1;
      const scope = normalizeYearScope(params.get("scope") || "ytd");
      const ledgerScope = normalizeLedgerScope(params.get("ledger_scope") || "all");
      const essentialsOnly = params.get("essentials_only") !== "false";
      const settings = getSettings(db);
      const defaults = settings.defaults || normalizeSettingsDefaults({});
      const basis = normalizeProgressBasis(defaults.progressBasis);
      const activeTemplates = getTemplates(db).filter((template) => template.active !== false);
      const monthEnd = scope === "full" ? 12 : month;
      const monthTotals = computeProgressTotals(
        filterLedgerScopeRows(getProgressInstancesForMonth(db, yearRaw, month, activeTemplates), ledgerScope),
        essentialsOnly
      );
      let yearRequiredScope = 0;
      let yearDoneScope = 0;
      let yearRemainingScope = 0;
      let yearDoneOutsideScope = 0;
      const remainingRows = [];
      for (let m = 1; m <= 12; m += 1) {
        const scopedRows = filterLedgerScopeRows(
          getProgressInstancesForMonth(db, yearRaw, m, activeTemplates),
          ledgerScope
        );
        const totals = computeProgressTotals(scopedRows, essentialsOnly);
        if (m <= monthEnd) {
          yearRequiredScope += totals.required;
          yearDoneScope += totals.done;
          yearRemainingScope += totals.remaining;
          const filtered = essentialsOnly ? scopedRows.filter((row) => row.essential_snapshot) : scopedRows;
          filtered.forEach((row) => {
            if (row.status_derived === "skipped") return;
            if (Number(row.amount_remaining || 0) <= 0) return;
            remainingRows.push(row);
          });
        } else {
          yearDoneOutsideScope += totals.done;
        }
      }
      const yearTotals = {
        required: roundMoney(yearRequiredScope),
        done: roundMoney(yearDoneScope),
        remaining: roundMoney(yearRemainingScope),
      };
      const prepaidFutureDone = roundMoney(yearDoneOutsideScope);
      const yearDoneIncludingPrepaid = roundMoney(yearTotals.done + prepaidFutureDone);
      let monthTarget = monthTotals.required;
      let yearTarget = yearTotals.required;
      if (basis === "manual") {
        if (defaults.monthlyGoalAmount > 0) monthTarget = roundMoney(defaults.monthlyGoalAmount);
        if (defaults.yearlyGoalAmount > 0) yearTarget = roundMoney(defaults.yearlyGoalAmount);
        else if (defaults.monthlyGoalAmount > 0) yearTarget = roundMoney(defaults.monthlyGoalAmount * monthEnd);
      }
      const monthPercent = monthTarget > 0 ? (monthTotals.done / monthTarget) * 100 : 0;
      const yearPercent = yearTarget > 0 ? (yearDoneIncludingPrepaid / yearTarget) * 100 : 0;
      const scopeLabel = scope === "full" ? "Full Year" : `YTD (through month ${monthEnd})`;
      const attachedYearRows = filterLedgerScopeRows(
        attachPayments(db, getInstances(db).filter((inst) => inst.year === yearRaw)),
        ledgerScope
      );
      const filteredYearRows = essentialsOnly
        ? attachedYearRows.filter((row) => row.essential_snapshot)
        : attachedYearRows;
      const paidRows = filteredYearRows
        .filter((row) => row.status_derived !== "skipped" && Number(row.amount_paid || 0) > 0)
        .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
      remainingRows.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
      const lines = [];
      lines.push("Au Jour Le Jour - Yearly Receipt");
      lines.push(`Generated: ${nowIsoLocal()}`);
      lines.push(`Year: ${yearRaw}`);
      lines.push(`Scope: ${scopeLabel}`);
      lines.push(`Ledger scope: ${getLedgerScopeLabel(ledgerScope)}`);
      lines.push(`Essentials only: ${essentialsOnly ? "Yes" : "No"}`);
      lines.push(" ");
      lines.push("Confirmed Totals");
      lines.push(`- Month progress: ${Math.round(monthPercent)}% (${formatMoney(monthTotals.done, settings)} of ${formatMoney(monthTarget, settings)})`);
      lines.push(`- Year progress: ${Math.round(yearPercent)}% (${formatMoney(yearDoneIncludingPrepaid, settings)} of ${formatMoney(yearTarget, settings)})`);
      lines.push(`- Remaining in scope: ${formatMoney(yearTotals.remaining, settings)}`);
      lines.push(`- Prepaid future months: ${formatMoney(prepaidFutureDone, settings)}`);
      lines.push(" ");
      lines.push(`Confirmed paid items (${paidRows.length})`);
      if (paidRows.length === 0) {
        lines.push("- None");
      } else {
        paidRows.forEach((row) => {
          const line = `- ${row.due_date} | ${row.name_snapshot} | paid ${formatMoney(Number(row.amount_paid || 0), settings)} of ${formatMoney(Number(row.amount || 0), settings)}`;
          wrapPdfLine(line).forEach((wrapped) => lines.push(wrapped));
        });
      }
      lines.push(" ");
      lines.push(`Remaining items in scope (${remainingRows.length})`);
      if (remainingRows.length === 0) {
        lines.push("- None");
      } else {
        remainingRows.forEach((row) => {
          const line = `- ${row.due_date} | ${row.name_snapshot} | remaining ${formatMoney(Number(row.amount_remaining || 0), settings)}`;
          wrapPdfLine(line).forEach((wrapped) => lines.push(wrapped));
        });
      }
      const pages = [];
      for (let i = 0; i < lines.length; i += 48) {
        pages.push(lines.slice(i, i + 48));
      }
      const pdfBuffer = buildReceiptPdf(pages);
      return new Response(pdfBuffer, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Cache-Control": "no-store",
        },
      });
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
        shared_household: !!item.shared_household_snapshot,
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
          shared_household: !!action.shared_household,
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
        template.shared_household = action.shared_household ?? template.shared_household;
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
      } else if (type === "SET_AVAILABLE_NOW") {
        const year = Number(action.year);
        const month = Number(action.month);
        if (!validYearMonth(year, month)) return bad("INVALID_INPUT", "year and month required");
        const availableNow = Number(action.available_now);
        if (!Number.isFinite(availableNow) || availableNow < 0) {
          return bad("INVALID_INPUT", "available_now must be >= 0");
        }
        const rows = getMonthSettings(db);
        const existing =
          rows.find((entry) => Number(entry.year) === year && Number(entry.month) === month) || null;
        const nextRow = existing || { year, month, cash_start: 0, available_now: 0, updated_at: "" };
        nextRow.available_now = roundMoney(availableNow);
        nextRow.updated_at = new Date().toISOString();
        if (!existing) rows.push(nextRow);
        payload = { ok: true };
      } else {
        return bad("INVALID_INPUT", "Unknown action type");
      }
      const saved = safeSaveDb(db);
      if (!saved.ok) return jsonResponse(500, { ok: false, error: saved.error });
      return ok(payload);
    }

    if (path === "/internal/behavior/features" && req.method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return bad("INVALID_INPUT", "Invalid year/month");
      const windowRaw = Number(params.get("window") || 3);
      const safeWindow = Number.isInteger(windowRaw) && windowRaw > 0 ? windowRaw : 3;
      const features = computeBehaviorFeatures(db, parsed.year, parsed.month, safeWindow);
      return ok({
        app: "au-jour-le-jour",
        app_version: "web",
        schema_version: "1",
        period: `${parsed.year}-${pad2(parsed.month)}`,
        window_months: safeWindow,
        generated_at: nowIsoLocal(),
        features,
      });
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
    if (url.pathname === "/internal/behavior/features") {
      try {
        return await handleApi(req);
      } catch (err) {
        return jsonResponse(500, { ok: false, error: { code: "INTERNAL", message: "Unexpected error", details: {} } });
      }
    }
    if (url.pathname.startsWith("/internal/")) {
      return jsonResponse(503, {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Mamdou is available in the local app only.",
          details: {},
        },
      });
    }
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
