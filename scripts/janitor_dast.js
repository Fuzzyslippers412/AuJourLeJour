/* Janitor DAST-lite: optional OWASP ZAP baseline wrapper */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const reportDir = path.join(__dirname, "..", "reports");
const reportPath = path.join(reportDir, "janitor-zap.json");
const target = process.env.AJL_DAST_TARGET || "http://127.0.0.1:4567";
const zapCmd = process.env.AJL_ZAP_CMD || "zap-baseline.py";

function writeReport(payload) {
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function main() {
  const check = spawnSync("which", [zapCmd], { encoding: "utf8" });
  if (check.status !== 0) {
    writeReport({
      profile: "janitor-dast",
      status: "skipped",
      reason: `${zapCmd} not available in PATH`,
      target,
      generated_at: new Date().toISOString(),
    });
    process.stdout.write(`Janitor DAST skipped: ${zapCmd} not found.\n`);
    return;
  }

  const outFile = path.join(reportDir, "janitor-zap-raw.json");
  const run = spawnSync(
    zapCmd,
    ["-t", target, "-J", outFile, "-I", "-m", "3"],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  );

  const payload = {
    profile: "janitor-dast",
    status: run.status === 0 ? "passed" : "failed",
    target,
    generated_at: new Date().toISOString(),
    exit_code: run.status,
    stdout: String(run.stdout || "").slice(0, 5000),
    stderr: String(run.stderr || "").slice(0, 5000),
    raw_report: fs.existsSync(outFile) ? path.basename(outFile) : null,
  };
  writeReport(payload);

  if (run.status !== 0) {
    throw new Error("DAST baseline reported failures");
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`${String(err?.message || err)}\n`);
  process.exit(1);
}
