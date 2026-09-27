#!/usr/bin/env node
/**
 * Fast manifest checks (no VS Code host). Used in CI before compile.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const declared = (pkg.contributes?.commands ?? []).map((c) => c.command).sort();

const re = /registerCommand\s*\(\s*['"](modelbound\.[^'"]+)['"]/g;
const registered = new Set();
for (const file of fs.readdirSync(path.join(root, "src"))) {
  if (!file.endsWith(".ts") || file.includes(".test.")) continue;
  const text = fs.readFileSync(path.join(root, "src", file), "utf8");
  let m;
  while ((m = re.exec(text))) registered.add(m[1]);
}

const missing = declared.filter((c) => !registered.has(c));
if (missing.length) {
  console.error("✗ package.json commands not registered in src:", missing.join(", "));
  process.exit(1);
}

const repo = pkg.repository?.url ?? pkg.repository ?? "";
if (!repo.includes("modelbound-cursor-extension")) {
  console.error("✗ package.json repository must point at modelbound-cursor-extension for release provenance");
  process.exit(1);
}

for (const rel of ["docs/PARITY.md", "presets/harness.json"]) {
  if (!fs.existsSync(path.join(root, rel))) {
    console.error(`✗ missing ${rel}`);
    process.exit(1);
  }
}

console.log(`✓ ${declared.length} palette commands registered in source`);
console.log("✓ repository + parity artifacts");
console.log("Manifest validation passed.");
