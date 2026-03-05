/* Janitor Hygiene: dependency, license, and lockfile checks */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.join(__dirname, "..");
const allowlistPath = path.join(repoRoot, "security", "licenses-allowlist.json");
const lockfilePath = path.join(repoRoot, "package-lock.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
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

function main() {
  checkLockfileSync();
  checkLicenses();
  checkAudit();
  process.stdout.write("Janitor hygiene complete: lockfile, license, and audit checks passed.\n");
}

try {
  main();
} catch (err) {
  fail(String(err?.message || err));
  process.exit(1);
}
