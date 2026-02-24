(() => {
  if (!window.Dexie) {
    console.warn("Dexie not loaded; PWA storage disabled.");
    return;
  }

  window.AJL_PWA = true;
  const LLM_BASE_URL = window.AJL_LLM_BASE_URL ? String(window.AJL_LLM_BASE_URL) : "";
  const LLM_ENABLED = Boolean(LLM_BASE_URL);

  const db = new Dexie("ajl_pwa");
  db.version(1).stores({
    templates: "id, active, name",
    instances: "id, [year+month], [template_id+year+month], template_id, due_date, status",
    payment_events: "id, instance_id, paid_date",
    month_settings: "[year+month]",
    sinking_funds: "id, active, due_date",
    sinking_events: "id, fund_id, event_date",
    agent_command_log: "id, created_at, status",
    assistant_chat: "id, created_at, role",
  });

  function uuid() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID() : `id_${Date.now()}_${Math.random()}`;
  }

  function validId(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  function validYearMonth(year, month) {
    return Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12;
  }

  async function purgeInvalidRows() {
    await db.open();
    const badInstances = await db.instances
      .filter((row) => !validId(row.id) || !validYearMonth(Number(row.year), Number(row.month)))
      .toArray();
    if (badInstances.length > 0) {
      const badIds = badInstances.map((row) => row.id).filter(validId);
      if (badIds.length > 0) {
        await db.payment_events.where("instance_id").anyOf(badIds).delete();
      }
      await db.instances.bulkDelete(badInstances.map((row) => row.id).filter(validId));
    }

    const badPayments = await db.payment_events
      .filter((row) => !validId(row.id) || !validId(row.instance_id))
      .toArray();
    if (badPayments.length > 0) {
      await db.payment_events.bulkDelete(badPayments.map((row) => row.id).filter(validId));
    }
  }

  async function resetLocalData() {
    await db.open();
    await Promise.all([
      db.templates.clear(),
      db.instances.clear(),
      db.payment_events.clear(),
      db.month_settings.clear(),
      db.sinking_funds.clear(),
      db.sinking_events.clear(),
      db.agent_command_log.clear(),
      db.assistant_chat.clear(),
    ]);
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function getAgentSessionId() {
    const key = "ajl_agent_session";
    try {
      const existing = window.localStorage.getItem(key);
      if (existing) return existing;
      const fresh = uuid();
      window.localStorage.setItem(key, fresh);
      return fresh;
    } catch (err) {
      return uuid();
    }
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

  function todayDate() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function clampDueDay(year, month, dueDay) {
    const last = new Date(year, month, 0).getDate();
    return Math.min(Math.max(1, Number(dueDay) || 1), last);
  }

  function toDateString(year, month, day) {
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  function parseYearMonth(params) {
    const year = Number(params.get("year"));
    const month = Number(params.get("month"));
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
    return { year, month };
  }

  function validateDateString(dateStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return "Invalid date";
    const date = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(date.valueOf())) return "Invalid date";
    return null;
  }

  function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function textResponse(text, status = 200, contentType = "text/plain") {
    return new Response(text, {
      status,
      headers: { "Content-Type": contentType },
    });
  }

  function isStorageError(err) {
    const message = String(err?.message || err || "");
    return message.includes("IDBKeyRange") || message.includes("DataError") || message.includes("IndexedDB");
  }

  async function hardResetDatabase() {
    try {
      await db.close();
    } catch (err) {
      // ignore
    }
    try {
      await db.delete();
    } catch (err) {
      // ignore
    }
  }

  async function ensureMonth(year, month) {
    if (!validYearMonth(year, month)) return;
    await db.open();
    const templates = await db.templates.where("active").equals(true).toArray();
    const stamp = nowIso();
    for (const template of templates) {
      if (!validId(template.id)) continue;
      const existing = await db.instances
        .where("[template_id+year+month]")
        .equals([template.id, year, month])
        .first();
      if (existing) continue;
      const dueDay = clampDueDay(year, month, template.due_day);
      const dueDate = toDateString(year, month, dueDay);
      await db.instances.add({
        id: uuid(),
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
    }
    await autoContributeForMonth(year, month);
  }

  async function attachPayments(instances) {
    const ids = instances.map((i) => i.id).filter(validId);
    const totals = new Map();
    if (ids.length > 0) {
      const payments = await db.payment_events.where("instance_id").anyOf(ids).toArray();
      payments.forEach((p) => {
        totals.set(p.instance_id, (totals.get(p.instance_id) || 0) + Number(p.amount || 0));
      });
    }
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

  async function getInstances(year, month) {
    if (!validYearMonth(year, month)) return [];
    const rows = await db.instances
      .where("[year+month]")
      .equals([year, month])
      .toArray();
    rows.sort((a, b) =>
      String(a.due_date).localeCompare(String(b.due_date)) ||
      String(a.name_snapshot).localeCompare(String(b.name_snapshot), undefined, { sensitivity: "base" })
    );
    return attachPayments(rows);
  }

  async function getPaymentsForMonth(year, month) {
    if (!validYearMonth(year, month)) return [];
    const instances = await db.instances.where("[year+month]").equals([year, month]).toArray();
    const ids = instances.map((i) => i.id).filter(validId);
    if (ids.length === 0) return [];
    const rows = await db.payment_events.where("instance_id").anyOf(ids).toArray();
    rows.sort((a, b) => String(b.paid_date).localeCompare(String(a.paid_date)));
    return rows;
  }

  function computeSummary(instances, { year, month, essentialsOnly }) {
    const list = essentialsOnly
      ? instances.filter((item) => item.essential_snapshot)
      : instances;
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

  async function getSinkingBalances() {
    const rows = await db.sinking_events.toArray();
    const map = new Map();
    rows.forEach((row) => {
      const delta = row.type === "WITHDRAWAL" ? -Number(row.amount || 0) : Number(row.amount || 0);
      map.set(row.fund_id, (map.get(row.fund_id) || 0) + delta);
    });
    return map;
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

  async function getSinkingFunds(year, month, includeInactive) {
    const refDate = new Date(year, month - 1, 1);
    let funds = await db.sinking_funds.toArray();
    if (!includeInactive) {
      funds = funds.filter((fund) => fund.active);
    }
    funds.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
    const balances = await getSinkingBalances();
    return funds.map((fund) => computeSinkingFundView(fund, Number(balances.get(fund.id) || 0), refDate));
  }

  async function hasContributionEvent(fundId, year, month) {
    const key = `${year}-${pad2(month)}`;
    const events = await db.sinking_events.where("fund_id").equals(fundId).toArray();
    return events.some((evt) => evt.type === "CONTRIBUTION" && String(evt.event_date || "").startsWith(key));
  }

  async function autoContributeForMonth(year, month) {
    const refDate = new Date(year, month - 1, 1);
    const funds = (await db.sinking_funds.toArray()).filter((fund) => fund.active && fund.auto_contribute);
    const balances = await getSinkingBalances();
    for (const fund of funds) {
      if (await hasContributionEvent(fund.id, year, month)) continue;
      const view = computeSinkingFundView(fund, Number(balances.get(fund.id) || 0), refDate);
      const amount = Number(view.monthly_contrib || 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      await db.sinking_events.add({
        id: uuid(),
        fund_id: fund.id,
        amount,
        type: "CONTRIBUTION",
        event_date: `${year}-${pad2(month)}-01`,
        note: "Auto contribution",
        created_at: nowIso(),
      });
    }
  }

  function addMonthsToDate(dateString, months) {
    const date = new Date(`${dateString}T00:00:00`);
    if (Number.isNaN(date.valueOf())) return dateString;
    const target = new Date(date);
    target.setMonth(target.getMonth() + Number(months || 0));
    const y = target.getFullYear();
    const m = pad2(target.getMonth() + 1);
    const d = pad2(target.getDate());
    return `${y}-${m}-${d}`;
  }

  function escapeCsv(value) {
    const raw = value == null ? "" : String(value);
    if (raw.includes(",") || raw.includes("\"") || raw.includes("\n")) {
      return `"${raw.replace(/\"/g, '""')}"`;
    }
    return raw;
  }

  async function handleExportMonthCSV(year, month) {
    const rows = await getInstances(year, month);
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
    for (const row of rows) {
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
    }
    return textResponse(lines.join("\n"), 200, "text/csv");
  }

  async function handleImportBackup(payload) {
    if (!payload) return jsonResponse({ ok: false, error: "Invalid payload" }, 400);
    await db.open();
    await db.transaction("rw", db.templates, db.instances, db.payment_events, db.month_settings, db.sinking_funds, db.sinking_events, db.agent_command_log, db.assistant_chat, async () => {
      await db.templates.clear();
      await db.instances.clear();
      await db.payment_events.clear();
      await db.month_settings.clear();
      await db.sinking_funds.clear();
      await db.sinking_events.clear();
      await db.agent_command_log.clear();
      await db.assistant_chat.clear();

      const templates = Array.isArray(payload.templates) ? payload.templates : [];
      const instances = Array.isArray(payload.instances) ? payload.instances : [];
      const payments = Array.isArray(payload.payment_events) ? payload.payment_events : [];
      const monthSettings = Array.isArray(payload.month_settings) ? payload.month_settings : [];
      const sinkingFunds = Array.isArray(payload.sinking_funds) ? payload.sinking_funds : [];
      const sinkingEvents = Array.isArray(payload.sinking_events) ? payload.sinking_events : [];

      for (const tmpl of templates) {
        await db.templates.add({
          id: String(tmpl.id || uuid()),
          name: tmpl.name,
          category: tmpl.category || null,
          amount_default: Number(tmpl.amount_default || 0),
          due_day: Number(tmpl.due_day || 1),
          autopay: !!tmpl.autopay,
          essential: tmpl.essential !== false,
          active: tmpl.active !== false,
          default_note: tmpl.default_note || null,
          match_payee_key: tmpl.match_payee_key || null,
          match_amount_tolerance: Number(tmpl.match_amount_tolerance || 0),
          created_at: tmpl.created_at || nowIso(),
          updated_at: tmpl.updated_at || nowIso(),
        });
      }

      for (const inst of instances) {
        await db.instances.add({
          id: String(inst.id || uuid()),
          template_id: String(inst.template_id || ""),
          year: Number(inst.year),
          month: Number(inst.month),
          name_snapshot: inst.name_snapshot || inst.name || "",
          category_snapshot: inst.category_snapshot || inst.category || null,
          amount: Number(inst.amount || 0),
          due_date: inst.due_date,
          autopay_snapshot: !!inst.autopay_snapshot,
          essential_snapshot: !!inst.essential_snapshot,
          status: ["pending", "paid", "skipped"].includes(inst.status) ? inst.status : "pending",
          paid_date: inst.paid_date || null,
          note: inst.note || null,
          created_at: inst.created_at || nowIso(),
          updated_at: inst.updated_at || nowIso(),
        });
      }

      for (const payment of payments) {
        await db.payment_events.add({
          id: String(payment.id || uuid()),
          instance_id: String(payment.instance_id || ""),
          amount: Number(payment.amount || 0),
          paid_date: payment.paid_date || todayDate(),
          created_at: payment.created_at || nowIso(),
        });
      }

      for (const setting of monthSettings) {
        await db.month_settings.put({
          year: Number(setting.year),
          month: Number(setting.month),
          cash_start: Number(setting.cash_start || 0),
          updated_at: setting.updated_at || nowIso(),
        });
      }

      for (const fund of sinkingFunds) {
        await db.sinking_funds.add({
          id: String(fund.id || uuid()),
          name: fund.name,
          category: fund.category || null,
          target_amount: Number(fund.target_amount || 0),
          due_date: fund.due_date,
          cadence: fund.cadence || "yearly",
          months_per_cycle: Number(fund.months_per_cycle || 1),
          essential: fund.essential !== false,
          active: fund.active !== false,
          auto_contribute: fund.auto_contribute !== false,
          created_at: fund.created_at || nowIso(),
          updated_at: fund.updated_at || nowIso(),
        });
      }

      for (const event of sinkingEvents) {
        await db.sinking_events.add({
          id: String(event.id || uuid()),
          fund_id: String(event.fund_id || ""),
          amount: Number(event.amount || 0),
          type: event.type || "CONTRIBUTION",
          event_date: event.event_date || todayDate(),
          note: event.note || null,
          created_at: event.created_at || nowIso(),
        });
      }
    });
    return jsonResponse({ ok: true });
  }

  async function handleAction(action) {
    const type = String(action.type || "").trim();
    if (!type) return { ok: false, error: "type is required" };
    switch (type) {
      case "MARK_PAID": {
        const id = String(action.instance_id || "");
        if (!id) return { ok: false, error: "instance_id is required" };
        const instance = await db.instances.get(id);
        if (!instance) return { ok: false, error: "Instance not found" };
        const payments = await db.payment_events.where("instance_id").equals(id).toArray();
        const amountPaid = payments.reduce((sum, p) => sum + Number(p.amount || 0), 0);
        const amountDue = Number(instance.amount || 0);
        const remaining = Math.max(0, amountDue - amountPaid);
        if (remaining > 0) {
          await db.payment_events.add({
            id: uuid(),
            instance_id: id,
            amount: remaining,
            paid_date: action.paid_date || todayDate(),
            created_at: nowIso(),
          });
        }
        await db.instances.update(id, { status: "paid", paid_date: action.paid_date || todayDate(), updated_at: nowIso() });
        const updated = await db.instances.get(id);
        return { ok: true, instance: (await attachPayments([updated]))[0] };
      }
      case "MARK_PENDING": {
        const id = String(action.instance_id || "");
        if (!id) return { ok: false, error: "instance_id is required" };
        await db.payment_events.where("instance_id").equals(id).delete();
        await db.instances.update(id, { status: "pending", paid_date: null, updated_at: nowIso() });
        const updated = await db.instances.get(id);
        return { ok: true, instance: (await attachPayments([updated]))[0] };
      }
      case "SKIP_INSTANCE": {
        const id = String(action.instance_id || "");
        if (!id) return { ok: false, error: "instance_id is required" };
        await db.instances.update(id, { status: "skipped", paid_date: null, updated_at: nowIso() });
        const updated = await db.instances.get(id);
        return { ok: true, instance: (await attachPayments([updated]))[0] };
      }
      case "ADD_PAYMENT": {
        const id = String(action.instance_id || "");
        const amount = Number(action.amount);
        if (!id) return { ok: false, error: "instance_id is required" };
        if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Amount must be > 0" };
        const paidDate = action.paid_date || todayDate();
        const dateError = validateDateString(paidDate);
        if (dateError) return { ok: false, error: dateError };
        const instance = await db.instances.get(id);
        if (!instance) return { ok: false, error: "Instance not found" };
        const paymentId = uuid();
        await db.payment_events.add({
          id: paymentId,
          instance_id: id,
          amount,
          paid_date: paidDate,
          created_at: nowIso(),
        });
        const updated = await db.instances.get(id);
        return { ok: true, payment: { id: paymentId, instance_id: id, amount, paid_date: paidDate }, instance: (await attachPayments([updated]))[0] };
      }
      case "UNDO_PAYMENT": {
        const id = String(action.payment_id || "");
        if (!id) return { ok: false, error: "payment_id is required" };
        const payment = await db.payment_events.get(id);
        if (!payment) return { ok: false, error: "Payment not found" };
        await db.payment_events.delete(id);
        const instance = await db.instances.get(payment.instance_id);
        return { ok: true, instance_id: payment.instance_id, instance: instance ? (await attachPayments([instance]))[0] : null };
      }
      case "UPDATE_INSTANCE_FIELDS": {
        const id = String(action.instance_id || "");
        if (!id) return { ok: false, error: "instance_id is required" };
        const updates = {};
        if (action.amount !== undefined) {
          const amt = Number(action.amount);
          if (!Number.isFinite(amt) || amt < 0) return { ok: false, error: "Amount must be >= 0" };
          updates.amount = amt;
        }
        if (action.due_date !== undefined) {
          const err = validateDateString(action.due_date);
          if (err) return { ok: false, error: err };
          updates.due_date = action.due_date;
        }
        if (action.status !== undefined) {
          if (!["pending", "paid", "skipped"].includes(action.status)) {
            return { ok: false, error: "Invalid status" };
          }
          updates.status = action.status;
        }
        if (action.paid_date !== undefined) {
          const err = validateDateString(action.paid_date);
          if (err) return { ok: false, error: err };
          updates.paid_date = action.paid_date;
        }
        if (action.note !== undefined) {
          updates.note = action.note || null;
        }
        updates.updated_at = nowIso();
        await db.instances.update(id, updates);
        const updated = await db.instances.get(id);
        return { ok: true, instance: (await attachPayments([updated]))[0] };
      }
      case "CREATE_TEMPLATE": {
        const name = String(action.name || "").trim();
        const amount = Number(action.amount_default);
        const dueDay = Number(action.due_day);
        if (!name) return { ok: false, error: "Name is required" };
        if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: "Amount must be >= 0" };
        if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return { ok: false, error: "Due day must be 1-31" };
        const stamp = nowIso();
        const id = uuid();
        const template = {
          id,
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
        await db.templates.add(template);
        const year = Number(action.year) || new Date().getFullYear();
        const month = Number(action.month) || new Date().getMonth() + 1;
        await ensureMonth(year, month);
        return { ok: true, template };
      }
      case "UPDATE_TEMPLATE": {
        const id = String(action.template_id || action.id || "");
        if (!id) return { ok: false, error: "template_id is required" };
        const template = await db.templates.get(id);
        if (!template) return { ok: false, error: "Template not found" };
        const updates = {
          name: action.name ?? template.name,
          category: action.category ?? template.category,
          amount_default: Number(action.amount_default ?? template.amount_default),
          due_day: Number(action.due_day ?? template.due_day),
          autopay: action.autopay ?? template.autopay,
          essential: action.essential ?? template.essential,
          active: action.active ?? template.active,
          default_note: action.default_note ?? template.default_note,
          match_payee_key: action.match_payee_key ?? template.match_payee_key,
          match_amount_tolerance: Number(action.match_amount_tolerance ?? template.match_amount_tolerance ?? 0),
          updated_at: nowIso(),
        };
        await db.templates.update(id, updates);
        const year = Number(action.year);
        const month = Number(action.month);
        if (Number.isInteger(year) && Number.isInteger(month)) {
          await applyTemplateToMonth({ ...template, ...updates }, year, month);
        }
        return { ok: true, template: { ...template, ...updates } };
      }
      case "ARCHIVE_TEMPLATE": {
        const id = String(action.template_id || "");
        if (!id) return { ok: false, error: "template_id is required" };
        await db.templates.update(id, { active: false, updated_at: nowIso() });
        return { ok: true };
      }
      case "DELETE_TEMPLATE": {
        const id = String(action.template_id || "");
        if (!id) return { ok: false, error: "template_id is required" };
        const year = Number(action.year);
        const month = Number(action.month);
        await deleteTemplateFromMonth(id, year, month);
        return { ok: true };
      }
      case "APPLY_TEMPLATES": {
        const year = Number(action.year);
        const month = Number(action.month);
        if (!Number.isInteger(year) || !Number.isInteger(month)) return { ok: false, error: "year and month required" };
        const templates = await db.templates.toArray();
        for (const tmpl of templates) {
          await applyTemplateToMonth(tmpl, year, month);
        }
        return { ok: true };
      }
      case "SET_CASH_START": {
        const year = Number(action.year);
        const month = Number(action.month);
        const cashStart = Number(action.cash_start);
        if (!Number.isInteger(year) || !Number.isInteger(month)) return { ok: false, error: "year and month required" };
        if (!Number.isFinite(cashStart) || cashStart < 0) return { ok: false, error: "cash_start invalid" };
        await db.month_settings.put({ year, month, cash_start: cashStart, updated_at: nowIso() });
        return { ok: true };
      }
      case "CREATE_FUND": {
        const name = String(action.name || "").trim();
        const targetAmount = Number(action.target_amount);
        if (!name) return { ok: false, error: "Name is required" };
        if (!Number.isFinite(targetAmount) || targetAmount < 0) return { ok: false, error: "target_amount invalid" };
        if (!action.due_date) return { ok: false, error: "due_date required" };
        const fund = {
          id: uuid(),
          name,
          category: action.category || null,
          target_amount: targetAmount,
          due_date: action.due_date,
          cadence: action.cadence || "yearly",
          months_per_cycle: Number(action.months_per_cycle || 1),
          essential: action.essential !== false,
          active: action.active !== false,
          auto_contribute: action.auto_contribute !== false,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        await db.sinking_funds.add(fund);
        return { ok: true, fund };
      }
      case "UPDATE_FUND": {
        const id = String(action.fund_id || "");
        if (!id) return { ok: false, error: "fund_id is required" };
        const fund = await db.sinking_funds.get(id);
        if (!fund) return { ok: false, error: "Fund not found" };
        const updates = {
          name: action.name ?? fund.name,
          category: action.category ?? fund.category,
          target_amount: Number(action.target_amount ?? fund.target_amount),
          due_date: action.due_date ?? fund.due_date,
          cadence: action.cadence ?? fund.cadence,
          months_per_cycle: Number(action.months_per_cycle ?? fund.months_per_cycle),
          essential: action.essential ?? fund.essential,
          active: action.active ?? fund.active,
          auto_contribute: action.auto_contribute ?? fund.auto_contribute,
          updated_at: nowIso(),
        };
        await db.sinking_funds.update(id, updates);
        return { ok: true, fund: { ...fund, ...updates } };
      }
      case "ARCHIVE_FUND": {
        const id = String(action.fund_id || "");
        if (!id) return { ok: false, error: "fund_id is required" };
        await db.sinking_funds.update(id, { active: false, updated_at: nowIso() });
        return { ok: true };
      }
      case "DELETE_FUND": {
        const id = String(action.fund_id || "");
        if (!id) return { ok: false, error: "fund_id is required" };
        await db.sinking_events.where("fund_id").equals(id).delete();
        await db.sinking_funds.delete(id);
        return { ok: true };
      }
      case "ADD_SINKING_EVENT": {
        const id = String(action.fund_id || "");
        const amount = Number(action.amount);
        const eventType = String(action.event_type || action.type || "").toUpperCase();
        if (!id) return { ok: false, error: "fund_id is required" };
        if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "amount invalid" };
        if (!eventType) return { ok: false, error: "event_type required" };
        const eventDate = action.event_date || todayDate();
        await db.sinking_events.add({
          id: uuid(),
          fund_id: id,
          amount,
          type: eventType,
          event_date: eventDate,
          note: action.note || null,
          created_at: nowIso(),
        });
        return { ok: true };
      }
      case "MARK_FUND_PAID": {
        const id = String(action.fund_id || "");
        if (!id) return { ok: false, error: "fund_id is required" };
        const fund = await db.sinking_funds.get(id);
        if (!fund) return { ok: false, error: "Fund not found" };
        const amount = action.amount !== undefined ? Number(action.amount) : Number(fund.target_amount || 0);
        if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "amount invalid" };
        const eventDate = action.event_date || todayDate();
        await db.sinking_events.add({
          id: uuid(),
          fund_id: id,
          amount,
          type: "WITHDRAWAL",
          event_date: eventDate,
          note: "Bill paid",
          created_at: nowIso(),
        });
        const monthsPer = resolveMonthsPerCycle(fund.cadence, fund.months_per_cycle);
        const nextDue = addMonthsToDate(fund.due_date, monthsPer);
        await db.sinking_funds.update(id, { due_date: nextDue, updated_at: nowIso() });
        return { ok: true };
      }
      case "GENERATE_MONTH": {
        const year = Number(action.year);
        const month = Number(action.month);
        if (!Number.isInteger(year) || !Number.isInteger(month)) return { ok: false, error: "year and month required" };
        await ensureMonth(year, month);
        return { ok: true };
      }
      default:
        return { ok: false, error: "Unknown action type" };
    }
  }

  async function applyTemplateToMonth(template, year, month) {
    if (!template || !validId(template.id) || !validYearMonth(year, month)) return;
    if (template.active) {
      await ensureMonth(year, month);
    }
    const dueDay = clampDueDay(year, month, template.due_day);
    const dueDate = toDateString(year, month, dueDay);
    const instance = await db.instances
      .where("[template_id+year+month]")
      .equals([template.id, year, month])
      .first();
    if (!instance) return;
    await db.instances.update(instance.id, {
      name_snapshot: template.name,
      category_snapshot: template.category || null,
      amount: Number(template.amount_default || 0),
      due_date: dueDate,
      autopay_snapshot: !!template.autopay,
      essential_snapshot: template.essential !== false,
      updated_at: nowIso(),
    });
  }

  async function deleteTemplateFromMonth(templateId, year, month) {
    if (!validId(templateId)) return;
    const instances = await db.instances.where("template_id").equals(templateId).toArray();
    const targets = instances.filter((inst) => {
      if (!Number.isInteger(year) || !Number.isInteger(month)) return true;
      if (inst.year > year) return true;
      if (inst.year === year && inst.month >= month) return true;
      return false;
    });
    const ids = targets.map((inst) => inst.id).filter(validId);
    if (ids.length > 0) {
      await db.payment_events.where("instance_id").anyOf(ids).delete();
      await db.instances.where("id").anyOf(ids).delete();
    }
    await db.templates.delete(templateId);
  }

  async function handleApi(path, method, params, body) {
    await db.open();

    if (path === "/api/health") {
      return jsonResponse({ ok: true });
    }

    if (path === "/api/reset-local" && method === "POST") {
      await resetLocalData();
      return jsonResponse({ ok: true });
    }

    if (path === "/api/ensure-month" && method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return jsonResponse({ error: "Invalid year/month" }, 400);
      await ensureMonth(parsed.year, parsed.month);
      return jsonResponse({ ok: true });
    }

    if (path === "/api/templates" && method === "GET") {
      const templates = await db.templates.toArray();
      templates.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));
      return jsonResponse(templates);
    }

    if (path.startsWith("/api/templates/") && method === "PUT") {
      const id = path.split("/")[3];
      const template = await db.templates.get(id);
      if (!template) return jsonResponse({ error: "Template not found" }, 404);
      const updates = {
        name: body.name || "",
        category: body.category || null,
        amount_default: Number(body.amount_default || 0),
        due_day: Number(body.due_day || 1),
        autopay: !!body.autopay,
        essential: !!body.essential,
        active: !!body.active,
        default_note: body.default_note || null,
        match_payee_key: body.match_payee_key || null,
        match_amount_tolerance: Number(body.match_amount_tolerance || 0),
        updated_at: nowIso(),
      };
      await db.templates.update(id, updates);
      const parsed = parseYearMonth(params);
      if (parsed) {
        await applyTemplateToMonth({ ...template, ...updates }, parsed.year, parsed.month);
      }
      return jsonResponse({ ok: true });
    }

    if (path.startsWith("/api/templates/") && method === "DELETE") {
      const id = path.split("/")[3];
      const parsed = parseYearMonth(params);
      const year = parsed ? parsed.year : null;
      const month = parsed ? parsed.month : null;
      await deleteTemplateFromMonth(id, year, month);
      return jsonResponse({ ok: true });
    }

    if (path.startsWith("/api/templates/") && path.endsWith("/archive") && method === "POST") {
      const id = path.split("/")[3];
      await db.templates.update(id, { active: false, updated_at: nowIso() });
      return jsonResponse({ ok: true });
    }

    if (path === "/api/instances" && method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return jsonResponse({ error: "Invalid year/month" }, 400);
      const rows = await getInstances(parsed.year, parsed.month);
      return jsonResponse(rows);
    }

    if (path.startsWith("/api/instances/") && path.endsWith("/payments") && method === "POST") {
      const id = path.split("/")[3];
      const amount = Number(body?.amount);
      if (!Number.isFinite(amount) || amount <= 0) return jsonResponse({ error: "Amount must be > 0" }, 400);
      const paidDate = body.paid_date || todayDate();
      const error = validateDateString(paidDate);
      if (error) return jsonResponse({ error }, 400);
      const instance = await db.instances.get(id);
      if (!instance) return jsonResponse({ error: "Instance not found" }, 404);
      const paymentId = uuid();
      await db.payment_events.add({ id: paymentId, instance_id: id, amount, paid_date: paidDate, created_at: nowIso() });
      const updated = await db.instances.get(id);
      return jsonResponse({ ok: true, payment: { id: paymentId, instance_id: id, amount, paid_date: paidDate }, instance: (await attachPayments([updated]))[0] });
    }

    if (path.startsWith("/api/instances/") && path.endsWith("/undo-paid") && method === "POST") {
      const id = path.split("/")[3];
      await db.payment_events.where("instance_id").equals(id).delete();
      await db.instances.update(id, { status: "pending", paid_date: null, updated_at: nowIso() });
      const updated = await db.instances.get(id);
      if (!updated) return jsonResponse({ error: "Instance not found" }, 404);
      return jsonResponse((await attachPayments([updated]))[0]);
    }

    if (path.startsWith("/api/instances/") && method === "PATCH") {
      const id = path.split("/")[3];
      const updates = {};
      if (body.amount !== undefined) {
        const amt = Number(body.amount);
        if (!Number.isFinite(amt) || amt < 0) return jsonResponse({ error: "Amount must be >= 0" }, 400);
        updates.amount = amt;
      }
      if (body.due_date !== undefined) {
        const err = validateDateString(body.due_date);
        if (err) return jsonResponse({ error: err }, 400);
        updates.due_date = body.due_date;
      }
      if (body.status !== undefined) {
        if (!["pending", "paid", "skipped"].includes(body.status)) return jsonResponse({ error: "Invalid status" }, 400);
        updates.status = body.status;
      }
      if (body.paid_date !== undefined) {
        const err = validateDateString(body.paid_date);
        if (err) return jsonResponse({ error: err }, 400);
        updates.paid_date = body.paid_date;
      }
      if (body.note !== undefined) {
        updates.note = body.note || null;
      }
      updates.updated_at = nowIso();
      await db.instances.update(id, updates);
      const updated = await db.instances.get(id);
      return jsonResponse((await attachPayments([updated]))[0]);
    }

    if (path === "/api/payments" && method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return jsonResponse({ error: "Invalid year/month" }, 400);
      const rows = await getPaymentsForMonth(parsed.year, parsed.month);
      return jsonResponse(rows);
    }

    if (path.startsWith("/api/payments/") && method === "DELETE") {
      const id = path.split("/")[3];
      const payment = await db.payment_events.get(id);
      if (!payment) return jsonResponse({ error: "Payment not found" }, 404);
      await db.payment_events.delete(id);
      const instance = await db.instances.get(payment.instance_id);
      return jsonResponse({ ok: true, instance_id: payment.instance_id, instance: instance ? (await attachPayments([instance]))[0] : null });
    }

    if (path === "/api/month-settings" && method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return jsonResponse({ error: "Invalid year/month" }, 400);
      const row = await db.month_settings.get([parsed.year, parsed.month]);
      return jsonResponse({ cash_start: Number(row?.cash_start || 0) });
    }

    if (path === "/api/month-settings" && method === "POST") {
      const year = Number(body.year);
      const month = Number(body.month);
      const cashStart = Number(body.cash_start);
      if (!Number.isInteger(year) || !Number.isInteger(month)) return jsonResponse({ error: "Invalid year/month" }, 400);
      if (!Number.isFinite(cashStart) || cashStart < 0) return jsonResponse({ error: "cash_start invalid" }, 400);
      await db.month_settings.put({ year, month, cash_start: cashStart, updated_at: nowIso() });
      return jsonResponse({ ok: true });
    }

    if (path === "/api/sinking-funds" && method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return jsonResponse({ error: "Invalid year/month" }, 400);
      const includeInactive = params.get("include_inactive") === "1";
      const funds = await getSinkingFunds(parsed.year, parsed.month, includeInactive);
      return jsonResponse(funds);
    }

    if (path === "/api/apply-templates" && method === "POST") {
      const parsed = parseYearMonth(params);
      if (!parsed) return jsonResponse({ error: "Invalid year/month" }, 400);
      const templates = await db.templates.toArray();
      for (const tmpl of templates) {
        await applyTemplateToMonth(tmpl, parsed.year, parsed.month);
      }
      return jsonResponse({ ok: true });
    }

    if (path === "/api/export/backup.json" && method === "GET") {
      const templates = await db.templates.toArray();
      const instances = await db.instances.toArray();
      const payments = await db.payment_events.toArray();
      const monthSettings = await db.month_settings.toArray();
      const sinkingFunds = await db.sinking_funds.toArray();
      const sinkingEvents = await db.sinking_events.toArray();
      return jsonResponse({
        app: "au-jour-le-jour",
        app_version: "pwa",
        schema_version: "2",
        exported_at: nowIsoLocal(),
        templates,
        instances,
        payment_events: payments,
        month_settings: monthSettings,
        sinking_funds: sinkingFunds,
        sinking_events: sinkingEvents,
      });
    }

    if (path === "/api/import/backup" && method === "POST") {
      return handleImportBackup(body);
    }

    if (path === "/api/export/month.csv" && method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return jsonResponse({ error: "Invalid year/month" }, 400);
      return handleExportMonthCSV(parsed.year, parsed.month);
    }

    if (path === "/api/v1/summary" && method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return jsonResponse({ error: "Invalid year/month" }, 400);
      await ensureMonth(parsed.year, parsed.month);
      const essentialsOnly = params.get("essentials_only") !== "false";
      const instances = await getInstances(parsed.year, parsed.month);
      const summary = computeSummary(instances, {
        year: parsed.year,
        month: parsed.month,
        essentialsOnly,
      });
      const funds = await getSinkingFunds(parsed.year, parsed.month, false);
      const futureReserved = funds.reduce(
        (sum, fund) => sum + Math.max(0, Number(fund.balance || 0)),
        0
      );
      return jsonResponse({
        app: "au-jour-le-jour",
        app_version: "pwa",
        schema_version: "2",
        version: "pwa",
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

    if (path === "/api/v1/month" && method === "GET") {
      const parsed = parseYearMonth(params);
      if (!parsed) return jsonResponse({ error: "Invalid year/month" }, 400);
      await ensureMonth(parsed.year, parsed.month);
      const essentialsOnly = params.get("essentials_only") !== "false";
      const instances = await getInstances(parsed.year, parsed.month);
      const filtered = essentialsOnly
        ? instances.filter((item) => item.essential_snapshot)
        : instances;
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
      return jsonResponse({
        app: "au-jour-le-jour",
        app_version: "pwa",
        schema_version: "2",
        period: `${parsed.year}-${pad2(parsed.month)}`,
        items,
      });
    }

    if (path === "/api/v1/templates" && method === "GET") {
      const templates = await db.templates.toArray();
      templates.sort((a, b) =>
        String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" })
      );
      return jsonResponse({ app: "au-jour-le-jour", app_version: "pwa", schema_version: "2", templates });
    }

    if (path === "/api/v1/actions" && method === "POST") {
      const action = body || {};
      const result = await handleAction(action);
      if (!result.ok) return jsonResponse(result, 400);
      return jsonResponse(result);
    }

    if (path.startsWith("/internal/agent/log") && method === "POST") {
      const entry = body || {};
      await db.agent_command_log.add({
        id: uuid(),
        created_at: nowIso(),
        user_text: entry.user_text || "",
        kind: entry.kind || "command",
        summary: entry.summary || "",
        payload: entry.payload || null,
        result: entry.result || null,
        status: entry.status || "ok",
      });
      return jsonResponse({ ok: true });
    }

    if (path.startsWith("/internal/agent/log") && method === "GET") {
      const limitRaw = Number(params.get("limit") || 20);
      const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 20;
      const items = await db.agent_command_log.orderBy("created_at").reverse().limit(limit).toArray();
      return jsonResponse({ ok: true, items });
    }

    if (path === "/api/chat" && method === "GET") {
      const limitRaw = Number(params.get("limit") || 50);
      const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50;
      const items = await db.assistant_chat.orderBy("created_at").limit(limit).toArray();
      return jsonResponse({ ok: true, items });
    }

    if (path === "/api/chat" && method === "POST") {
      const role = String(body.role || "").trim();
      const text = String(body.text || "").trim();
      if (!role || !text) return jsonResponse({ ok: false, error: "Invalid message" }, 400);
      await db.assistant_chat.add({
        id: uuid(),
        created_at: nowIso(),
        role,
        text,
        meta: body.meta || "",
      });
      return jsonResponse({ ok: true });
    }

    if (path === "/api/chat" && method === "DELETE") {
      await db.assistant_chat.clear();
      return jsonResponse({ ok: true });
    }

    if (!LLM_ENABLED && path.startsWith("/api/llm/qwen/oauth/status") && method === "GET") {
      return jsonResponse({ connected: false, disabled: true });
    }

    if (!LLM_ENABLED && path.startsWith("/api/llm/qwen/oauth") && method === "POST") {
      return jsonResponse({ error: "Mamdou is available in the local app only." }, 503);
    }

    if (!LLM_ENABLED && path.startsWith("/internal/advisor/query") && method === "POST") {
      return jsonResponse({ ok: false, error: "Mamdou is available in the local app only." }, 503);
    }

    if (!LLM_ENABLED && path.startsWith("/internal/behavior/features") && method === "GET") {
      return jsonResponse({ ok: false, error: "Not available in web mode." }, 503);
    }

    return jsonResponse({ error: "Not found" }, 404);
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const request = typeof input === "string" ? null : input;
    const url = typeof input === "string" ? input : input.url;
    if (!url) return originalFetch(input, init);
    if (!window.__AJL_PWA_PURGE__) {
      window.__AJL_PWA_PURGE__ = true;
      purgeInvalidRows().catch(() => {});
    }
    const urlObj = new URL(url, window.location.origin);
    const pathname = urlObj.pathname;

    if (
      LLM_ENABLED &&
      (pathname.startsWith("/api/llm/") ||
        pathname.startsWith("/internal/advisor/") ||
        pathname.startsWith("/internal/behavior/"))
    ) {
      const target = new URL(pathname + urlObj.search, LLM_BASE_URL);
      const headers = new Headers(init.headers || {});
      headers.set("X-AJL-Session", getAgentSessionId());
      return originalFetch(target.toString(), { ...init, headers, credentials: "include" });
    }
    if (pathname.startsWith("/api/") || pathname.startsWith("/internal/")) {
      const method = (init.method || request?.method || "GET").toUpperCase();
      let body = null;
      if (init.body) {
        try {
          body = JSON.parse(init.body);
        } catch (err) {
          body = null;
        }
      }
      const params = new URL(url, window.location.origin).searchParams;
      try {
        return await handleApi(pathname, method, params, body);
      } catch (err) {
        if (isStorageError(err)) {
          await hardResetDatabase();
          setTimeout(() => window.location.reload(), 50);
        }
        return jsonResponse({ error: "Local storage error", detail: String(err?.message || err) }, 500);
      }
    }
    return originalFetch(input, init);
  };
})();
