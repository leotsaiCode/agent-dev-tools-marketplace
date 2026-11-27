#!/usr/bin/env bun
//
// Run before you push: checks the marketplace and every plugin in it.
// Usage: bun scripts/validate.ts
//
// Checks:
//   1. Every JSON file parses.
//   2. marketplace.json and each plugin.json agree (name, version), each
//      plugin has something to load, a README, and the modules hooks.json names.
//   3. No folder under claude/ is left out of marketplace.json.
//   4. `claude plugin validate` passes for each plugin, `claude plugin test`
//      when it has tests/, and strict `tsc` when it has a tsconfig.json.
//      None of them needs a login.
//   5. Strict `tsc` on the repo's own scripts (root tsconfig.json). Needs the
//      types from `bun install`.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PLUGINS_DIR = join(ROOT, "claude");
const MARKETPLACE = join(ROOT, ".claude-plugin", "marketplace.json");
const CAPABILITIES = ["skills", "commands", "agents", "hooks", ".mcp.json"];
const TYPESCRIPT_VERSION = "5.6.3";

let failed = false;
const ok = (msg: string) => console.log(`\x1b[32m ok \x1b[0m ${msg}`);
const fail = (msg: string) => {
  failed = true;
  console.log(`\x1b[31mFAIL\x1b[0m ${msg}`);
};
const rel = (path: string) => relative(ROOT, path);

type MarketplaceEntry = { name?: string; source?: unknown; version?: string; description?: string };

// ---- 1. JSON --------------------------------------------------------------

function findJsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === ".git" || entry.name === "node_modules" ? [] : findJsonFiles(path);
    }
    return entry.name.endsWith(".json") ? [path] : [];
  });
}

/** The parsed file, or undefined after reporting why it failed. */
function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    fail(`${rel(path)}: ${(error as Error).message}`);
    return undefined;
  }
}

for (const file of findJsonFiles(ROOT).sort()) {
  if (readJson(file) !== undefined) {
    ok(`JSON parses: ${rel(file)}`);
  }
}

// ---- 2. Marketplace and plugins -------------------------------------------

const marketplace = readJson<{ name?: string; owner?: unknown; plugins?: MarketplaceEntry[] }>(MARKETPLACE);
if (marketplace === undefined) {
  process.exit(1);
}
for (const key of ["name", "owner", "plugins"] as const) {
  if (marketplace[key] === undefined) {
    fail(`marketplace.json is missing ${key}`);
  }
}

const listed = new Set<string>();
const localPluginDirs: string[] = [];

for (const entry of marketplace.plugins ?? []) {
  const name = entry.name;
  if (!name) {
    fail("a marketplace.json entry has no name");
    continue;
  }
  if (listed.has(name)) {
    fail(`[${name}] listed twice in marketplace.json`);
  }
  listed.add(name);

  for (const key of ["source", "version", "description"] as const) {
    if (entry[key] === undefined) {
      fail(`[${name}] marketplace entry is missing ${key}`);
    }
  }
  if (typeof entry.source !== "string") {
    ok(`[${name}] source is not a local path; folder checks skipped`);
    continue;
  }

  const dir = resolve(ROOT, entry.source);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    fail(`[${name}] source folder does not exist: ${entry.source}`);
    continue;
  }
  localPluginDirs.push(dir);
  checkPlugin(name, entry, dir);
}

function checkPlugin(name: string, entry: MarketplaceEntry, dir: string): void {
  const manifestPath = join(dir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    fail(`[${name}] missing ${rel(manifestPath)}`);
    return;
  }
  const manifest = readJson<{ name?: string; version?: string }>(manifestPath);
  if (manifest === undefined) {
    return;
  }

  if (manifest.name !== name) {
    fail(`[${name}] plugin.json name is ${JSON.stringify(manifest.name)}, marketplace says ${JSON.stringify(name)}`);
  }
  if (basename(dir) !== name) {
    fail(`[${name}] folder is named ${basename(dir)}; it must match the plugin name`);
  }
  if (entry.version !== undefined && manifest.version !== entry.version) {
    fail(`[${name}] version differs: marketplace ${entry.version}, plugin.json ${manifest.version}`);
  }
  if (!existsSync(join(dir, "README.md"))) {
    fail(`[${name}] missing README.md (the plugin's detailed docs go there)`);
  }

  const provides = CAPABILITIES.filter((c) => existsSync(join(dir, c)));
  if (provides.length === 0) {
    fail(`[${name}] has none of ${CAPABILITIES.join(", ")}; installing it does nothing`);
  } else {
    ok(`[${name}] v${manifest.version} provides: ${provides.join(", ")}`);
  }

  const hooksPath = join(dir, "hooks", "hooks.json");
  const hooks = existsSync(hooksPath) ? readJson<{ modules?: string[] }>(hooksPath) : undefined;
  for (const module of hooks?.modules ?? []) {
    if (!existsSync(resolve(dirname(hooksPath), module))) {
      fail(`[${name}] hooks.json names a module that does not exist: ${module}`);
    }
  }
}

// ---- 3. Unlisted folders --------------------------------------------------

if (existsSync(PLUGINS_DIR)) {
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && !listed.has(entry.name)) {
      fail(`claude/${entry.name}/ is not listed in marketplace.json, so nobody can install it`);
    }
  }
}

// ---- 4. Claude Code's own checks, then types ------------------------------

function runCheck(argv: string[], label: string): void {
  const run = Bun.spawnSync(argv, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (run.exitCode === 0) {
    ok(label);
    return;
  }
  fail(label);
  const output = `${run.stdout.toString()}${run.stderr.toString()}`.trim().split("\n");
  console.log(output.slice(-30).map((line) => `       ${line}`).join("\n"));
}

if (Bun.which("claude") === null) {
  fail("claude is not on PATH: install Claude Code to run plugin validate / test");
} else {
  for (const dir of localPluginDirs) {
    runCheck(["claude", "plugin", "validate", dir], `claude plugin validate ${rel(dir)}`);
    if (existsSync(join(dir, "tests"))) {
      runCheck(["claude", "plugin", "test", dir], `claude plugin test ${rel(dir)}`);
    }
    // .claude-plugin/types/ is written only when a Claude Code session loads
    // the mod (not by `plugin validate`), so a clean checkout such as CI has
    // none: skip tsc there instead of failing on missing 'claude-code' types.
    if (existsSync(join(dir, "tsconfig.json"))) {
      if (!existsSync(join(dir, ".claude-plugin", "types", "claude-code", "index.d.ts"))) {
        console.log(`\x1b[33mskip\x1b[0m tsc (strict) ${rel(dir)}: no .claude-plugin/types/ (load the mod once with \`claude --plugin-dir ${rel(dir)}\`)`);
      } else {
        runCheck(["bunx", "-p", `typescript@${TYPESCRIPT_VERSION}`, "tsc", "-p", dir], `tsc (strict) ${rel(dir)}`);
      }
    }
  }
}

// ---- 5. The repo's own scripts --------------------------------------------

if (existsSync(join(ROOT, "tsconfig.json"))) {
  if (!existsSync(join(ROOT, "node_modules", "@types", "bun"))) {
    fail("tsc (strict) scripts: @types/bun is not installed; run `bun install` first");
  } else {
    runCheck(["bunx", "-p", `typescript@${TYPESCRIPT_VERSION}`, "tsc", "-p", ROOT], "tsc (strict) scripts");
  }
}

console.log();
console.log(failed ? "\x1b[31mSome checks failed. Fix them before you push.\x1b[0m" : "\x1b[32mAll checks passed.\x1b[0m");
process.exit(failed ? 1 : 0);
