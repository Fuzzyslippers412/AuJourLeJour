#!/usr/bin/env node
/* Simple AJL CLI for local power users */
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const command = argv[0];

function argValue(flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  return argv[idx + 1] || null;
}

function usage() {
  console.log(`AJL CLI

Commands:
  backup                 Copy SQLite DB to data/backups
  export-json            Export backup JSON via local server

Options:
  --port <port>          Local server port (default: 4567)
  --out <path>           Output file path

Examples:
  node scripts/ajl_cli.js backup
  node scripts/ajl_cli.js export-json --port 6709 --out ./ajl_backup.json
`);
}

function getDbPath() {
  const base = path.resolve(__dirname, "..");
  const db = process.env.AJL_DB_PATH || path.join(base, "data", "au_jour_le_jour.sqlite");
  return db;
}

function ensureBackupDir() {
  const base = path.resolve(__dirname, "..");
  const dir = process.env.AJL_BACKUP_DIR || path.join(base, "data", "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp() {
  const now = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

async function doBackup() {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error("Database not found:", dbPath);
    process.exit(1);
  }
  const outFlag = argValue("--out");
  const backupDir = ensureBackupDir();
  const filename = outFlag || path.join(backupDir, `au_jour_le_jour_${timestamp()}.sqlite`);
  fs.copyFileSync(dbPath, filename);
  console.log("Backup written:", filename);
}

async function doExportJson() {
  const port = Number(argValue("--port") || process.env.PORT || 4567);
  const outFlag = argValue("--out") || `./au_jour_le_jour_backup_${timestamp()}.json`;
  const url = `http://127.0.0.1:${port}/api/export/backup.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Export failed (${res.status}). Is the server running on port ${port}?`);
      process.exit(1);
    }
    const data = await res.text();
    fs.writeFileSync(outFlag, data);
    console.log("Backup JSON written:", outFlag);
  } catch (err) {
    console.error("Export failed. Is the server running?", err.message);
    process.exit(1);
  }
}

async function main() {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "backup") {
    await doBackup();
    return;
  }
  if (command === "export-json") {
    await doExportJson();
    return;
  }
  console.error("Unknown command:", command);
  usage();
  process.exit(1);
}

main();
