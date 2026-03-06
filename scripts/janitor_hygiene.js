/* Janitor Hygiene: dependency, license, and lockfile checks with report output */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.join(__dirname, "..");
const allowlistPath = path.join(repoRoot, "security", "licenses-allowlist.json");
const lockfilePath = path.join(repoRoot, "package-lock.json");
const reportPath = path.join(repoRoot, "reports", "janitor-hygiene.json");

function nowIso() {
  return new Date().toISOString();
}

function runCmd(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function normalizeLicense(value) {
  if (!value) return "UNKNOWN";
  if (typeof value === "string") return value.trim().toUpperCase();
  if (typeof value === "object" && typeof value.type === "string") {
    return value.type.trim().toUpperCase();
  }
  return String(value).trim().toUpperCase();
}

function licenseAllowed(licenseRaw, allowSet) {
  const license = normalizeLicense(licenseRaw);
  if (allowSet.has(license)) return true;
  const parts = license
    .split(/\s+OR\s+|\s+\|\s+|\/|,/i)
    .map((part) => part.replace(/[()]/g, "").trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  return parts.some((part) => allowSet.has(part.toUpperCase()));
}

function checkLockfileSync() {
  if (!fs.existsSync(lockfilePath)) {
    throw new Error("package-lock.json is missing");
  }
  const result = runCmd("npm", ["ci", "--omit=dev", "--ignore-scripts", "--dry-run"]);
  if (result.status !== 0) {
    throw new Error(
      `lockfile check failed (npm ci --dry-run).\n${String(result.stderr || result.stdout || "").trim()}`
    );
  }
}

function checkLicenses() {
  if (!fs.existsSync(allowlistPath)) {
    throw new Error(`license allowlist is missing: ${allowlistPath}`);
  }
  const allowRaw = fs.readFileSync(allowlistPath, "utf8");
  const allowParsed = JSON.parse(allowRaw);
  const allowSet = new Set((allowParsed.allow || []).map((item) => normalizeLicense(item)));

  const lockRaw = fs.readFileSync(lockfilePath, "utf8");
  const lock = JSON.parse(lockRaw);
  const packages = lock && typeof lock === "object" ? lock.packages || {} : {};
  const violations = [];

  Object.keys(packages).forEach((pkgPath) => {
    if (!pkgPath.startsWith("node_modules/")) return;
    const absPkgPath = path.join(repoRoot, pkgPath, "package.json");
    if (!fs.existsSync(absPkgPath)) return;
    const pkg = JSON.parse(fs.readFileSync(absPkgPath, "utf8"));
    const licenseRaw = pkg.license || pkg.licenses;
    const license = normalizeLicense(licenseRaw);
    if (!licenseAllowed(licenseRaw, allowSet)) {
      violations.push({
        name: pkg.name || pkgPath.replace(/^node_modules\//, ""),
        version: pkg.version || "unknown",
        license,
      });
    }
  });

  if (violations.length > 0) {
    const lines = violations
      .slice(0, 25)
      .map((v) => `- ${v.name}@${v.version} -> ${v.license}`)
      .join("\n");
    throw new Error(`license policy violations (${violations.length}):\n${lines}`);
  }
}

function checkAudit() {
  const result = runCmd("npm", ["audit", "--omit=dev", "--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(String(result.stdout || "{}"));
  } catch (err) {
    throw new Error(`npm audit JSON parse failed: ${String(err.message || err)}`);
  }
  const vulns = parsed?.metadata?.vulnerabilities || {};
  const high = Number(vulns.high || 0);
  const critical = Number(vulns.critical || 0);
  if (high > 0 || critical > 0) {
    throw new Error(`npm audit found vulnerabilities: high=${high}, critical=${critical}`);
  }
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function run() {
  const startedAt = Date.now();
  const checks = [
    { id: "lockfile_sync", title: "lockfile sync check", severity: "HIGH", run: checkLockfileSync },
    { id: "license_allowlist", title: "license allowlist check", severity: "HIGH", run: checkLicenses },
    { id: "audit_high_critical", title: "npm audit high/critical check", severity: "HIGH", run: checkAudit },
  ];
  const results = [];

  checks.forEach((check) => {
    const started = Date.now();
    const row = {
      id: check.id,
      title: check.title,
      name: check.title,
      severity: check.severity,
      attack: check.title,
      expected: "No high-risk supply-chain hygiene failures.",
      status: "passed",
      error: null,
      actual: "passed",
      request: null,
      response_meta: null,
      repro_curl: "",
      duration_ms: 0,
    };
    try {
      check.run();
      process.stdout.write(`PASS ${check.title}\n`);
    } catch (err) {
      row.status = "failed";
      row.error = String(err?.message || err);
      row.actual = row.error;
      process.stderr.write(`FAIL ${check.title}: ${row.error}\n`);
    }
    row.duration_ms = Date.now() - started;
    results.push(row);
  });

  const failed = results.filter((row) => row.status === "failed").length;
  const report = {
    profile: "janitor-hygiene",
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
  writeReport(report);
  process.stdout.write(`Janitor hygiene report: ${reportPath}\n`);
  if (failed > 0) process.exit(1);
}

try {
  run();
} catch (err) {
  process.stderr.write(`${String(err?.stack || err)}\n`);
  process.exit(1);
}
