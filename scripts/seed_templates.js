const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { randomUUID } = require("crypto");

const seedPath = path.join(__dirname, "..", "seeds", "monthly_expenses.json");
const samplePath = path.join(__dirname, "..", "seeds", "monthly_expenses.sample.json");
const dataDir = path.join(__dirname, "..", "data");
const dbFile = path.join(dataDir, "au_jour_le_jour.sqlite");

function nowIso() {
  return new Date().toISOString();
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function clampDueDay(year, month, dueDay) {
  const lastDay = lastDayOfMonth(year, month);
  return Math.min(Math.max(1, dueDay), lastDay);
}

function toDateString(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbFile);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    amount_default REAL NOT NULL,
    due_day INTEGER NOT NULL,
    autopay INTEGER NOT NULL DEFAULT 0,
    essential INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    default_note TEXT,
    match_payee_key TEXT,
    match_amount_tolerance REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    name_snapshot TEXT NOT NULL,
    category_snapshot TEXT,
    amount REAL NOT NULL,
    due_date TEXT NOT NULL,
    autopay_snapshot INTEGER NOT NULL,
    essential_snapshot INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','paid','skipped')),
    paid_date TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(template_id, year, month)
  );
`);

const usePath = fs.existsSync(seedPath) ? seedPath : samplePath;
const seed = JSON.parse(fs.readFileSync(usePath, "utf8"));
const templates = Array.isArray(seed.templates) ? seed.templates : [];

const findTemplate = db.prepare("SELECT id FROM templates WHERE name = ?");
const insertTemplate = db.prepare(
  `INSERT INTO templates (
    id, name, category, amount_default, due_day, autopay, essential, active, default_note,
    match_payee_key, match_amount_tolerance, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const findInstance = db.prepare(
  "SELECT id FROM instances WHERE template_id = ? AND year = ? AND month = ?"
);
const insertInstance = db.prepare(
  `INSERT INTO instances (
    id, template_id, year, month, name_snapshot, category_snapshot, amount, due_date,
    autopay_snapshot, essential_snapshot, status, paid_date, note, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const now = new Date();
const year = now.getFullYear();
const month = now.getMonth() + 1;
const stamp = nowIso();
let inserted = 0;

const run = db.transaction(() => {
  for (const tmpl of templates) {
    const name = String(tmpl.name || "").trim();
    if (!name) continue;
    const amount = Number(tmpl.amount_default);
    const dueDay = Number(tmpl.due_day);
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) continue;

    const exists = findTemplate.get(name);
    if (exists) continue;

    const id = randomUUID();
    insertTemplate.run(
      id,
      name,
      tmpl.category || null,
      amount,
      dueDay,
      tmpl.autopay ? 1 : 0,
      tmpl.essential === false ? 0 : 1,
      tmpl.active === false ? 0 : 1,
      tmpl.default_note || null,
      tmpl.match_payee_key || null,
      Number(tmpl.match_amount_tolerance || 0),
      stamp,
      stamp
    );

    const due = clampDueDay(year, month, dueDay);
    const dueDate = toDateString(year, month, due);
    if (!findInstance.get(id, year, month)) {
      insertInstance.run(
        randomUUID(),
        id,
        year,
        month,
        name,
        tmpl.category || null,
        amount,
        dueDate,
        tmpl.autopay ? 1 : 0,
        tmpl.essential === false ? 0 : 1,
        "pending",
        null,
        tmpl.default_note || null,
        stamp,
        stamp
      );
    }

    inserted += 1;
  }
});

run();

console.log(`Seeded ${inserted} templates.`);
