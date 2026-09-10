#!/usr/bin/env node
// Builds dist/ from source. Runs identically on Windows, macOS and Linux,
// which the old package.json build script (`rm -rf dist && tsc ... &&
// chmod +x ...`) did not: npm runs scripts through cmd.exe on Windows, and
// neither rm nor chmod exists there. That script is wired to `prepare`,
// which npm runs on `npm install`/`npm ci` in a git checkout, so a Windows
// contributor cloning this repository hit a broken install step.
//
// Steps:
//   1. remove dist/ (including stale content from a previous build)
//   2. run `tsc -p tsconfig.build.json`, propagating its exit code
//   3. on POSIX, mark dist/bin/adg.js executable -- it is a `bin` entry, so
//      the executable bit matters there. Windows has no such bit, so step 3
//      is skipped outright on win32 instead of being attempted and ignored.
//
// Contract:
//   node scripts/build.ts
//
// Exit codes: whatever `tsc` exits with (0 on success), or 1 if `tsc` could
// not even be spawned.

import { rmSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const BIN_ENTRY = join(DIST, "bin", "adg.js");

rmSync(DIST, { recursive: true, force: true });

const tsc = spawnSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", join(ROOT, "tsconfig.build.json")], {
  stdio: "inherit",
  cwd: ROOT,
});

if (tsc.error) {
  console.error(`scripts/build.ts: could not run tsc: ${tsc.error.message}`);
  process.exit(1);
}
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

if (process.platform !== "win32" && existsSync(BIN_ENTRY)) {
  chmodSync(BIN_ENTRY, 0o755);
}
