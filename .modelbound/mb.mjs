#!/usr/bin/env node
/**
 * ModelBound CLI launcher for Cursor slash commands.
 *
 * Resolution order:
 *   1. `modelbound` on PATH (global/local install)
 *   2. npx github:ModelBound/modelbound-cli (published source install)
 *
 * Loads MODELBOUND_API_KEY from ~/.modelbound/config.json when unset.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const env = { ...process.env };

if (!env.MODELBOUND_API_KEY) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".modelbound", "config.json"), "utf8"),
    );
    if (cfg.token) env.MODELBOUND_API_KEY = cfg.token;
  } catch {
    /* no config */
  }
}

function run(cmd, cmdArgs) {
  return spawnSync(cmd, cmdArgs, { stdio: "inherit", env, shell: false });
}

let result = run("modelbound", args);
if (!result.error) process.exit(result.status ?? 0);

if (result.error?.code === "ENOENT") {
  result = run("npx", ["-y", "github:ModelBound/modelbound-cli", ...args]);
  process.exit(result.status ?? 1);
}

process.exit(result.status ?? 1);
