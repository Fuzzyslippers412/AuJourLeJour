#!/usr/bin/env node
/* Keep docs frontend assets mirrored from public assets. */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CHECK_ONLY = process.argv.includes("--check");

const pairs = [
  ["public/app.js", "docs/app.js"],
  ["public/styles.css", "docs/styles.css"],
  ["public/favicon.svg", "docs/favicon.svg"],
  ["docs/reset.html", "docs/reset/index.html"],
  ["docs/safe.html", "docs/safe/index.html"],
];

function copyPair(fromRel, toRel) {
  const from = path.join(ROOT, fromRel);
  const to = path.join(ROOT, toRel);
  if (!fs.existsSync(from)) {
    throw new Error(`Missing source file: ${fromRel}`);
  }
  const fromRaw = fs.readFileSync(from, "utf8");
  const toRaw = fs.existsSync(to) ? fs.readFileSync(to, "utf8") : "";
  if (CHECK_ONLY) {
    if (toRaw !== fromRaw) {
      throw new Error(`Out of sync: ${toRel} differs from ${fromRel}`);
    }
    process.stdout.write(`checked ${toRel} == ${fromRel}\n`);
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, fromRaw);
  process.stdout.write(`synced ${toRel} <- ${fromRel}\n`);
}

function syncIndexHtml() {
  const from = path.join(ROOT, "public/index.html");
  const to = path.join(ROOT, "docs/index.html");
  if (!fs.existsSync(from)) {
    throw new Error("Missing source file: public/index.html");
  }
  let raw = fs.readFileSync(from, "utf8");

  raw = raw.replace(
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
    '<link rel="icon" href="./favicon.svg" type="image/svg+xml" />'
  );
  raw = raw.replace(
    '<link rel="stylesheet" href="/styles.css" />',
    '<link rel="stylesheet" href="./styles.css" />'
  );
  raw = raw.replace(
    '<script src="/app.js"></script>',
    '<script src="./web-adapter.js"></script>\n    <script src="./app.js"></script>'
  );

  if (CHECK_ONLY) {
    const current = fs.existsSync(to) ? fs.readFileSync(to, "utf8") : "";
    if (current !== raw) {
      throw new Error("Out of sync: docs/index.html differs from transformed public/index.html");
    }
    process.stdout.write("checked docs/index.html transform\n");
    return;
  }

  fs.writeFileSync(to, raw);
  process.stdout.write("synced docs/index.html <- public/index.html (transformed)\n");
}

function main() {
  for (const [fromRel, toRel] of pairs) {
    copyPair(fromRel, toRel);
  }
  syncIndexHtml();
}

main();
