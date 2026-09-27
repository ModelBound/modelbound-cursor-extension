import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.join(__dirname, "..");

function readPackageCommands(): string[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    contributes?: { commands?: Array<{ command: string }> };
  };
  return (pkg.contributes?.commands ?? []).map((c) => c.command).sort();
}

function registeredCommandsInSource(): Set<string> {
  const srcDir = path.join(root, "src");
  const re = /registerCommand\s*\(\s*['"](modelbound\.[^'"]+)['"]/g;
  const found = new Set<string>();
  for (const file of fs.readdirSync(srcDir)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const text = fs.readFileSync(path.join(srcDir, file), "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) found.add(m[1]);
  }
  return found;
}

test("package.json commands are registered in extension source", () => {
  const declared = readPackageCommands();
  const registered = registeredCommandsInSource();
  const missing = declared.filter((c) => !registered.has(c));
  assert.deepEqual(missing, [], `commands in package.json but not registerCommand(): ${missing.join(", ")}`);
});

test("harness presets ship for CLI parity", () => {
  const harness = JSON.parse(fs.readFileSync(path.join(root, "presets", "harness.json"), "utf8")) as {
    presets?: Record<string, unknown>;
  };
  for (const key of ["cautious", "balanced", "autonomous"]) {
    assert.ok(harness.presets?.[key], `missing harness preset: ${key}`);
  }
});

test("parity docs exist", () => {
  for (const rel of ["docs/PARITY.md", "docs/HARNESS.md", "docs/TRACING.md"]) {
    assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
  }
});
