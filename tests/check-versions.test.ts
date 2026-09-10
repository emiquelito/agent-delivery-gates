// Tests for scripts/check-versions.ts. Every test spawns the CLI as a real
// subprocess: stdout, stderr, and exit code are the contract, never an
// internal function's return value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI_PATH = join(ROOT, "scripts", "check-versions.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[] = []): RunResult {
  const result = spawnSync("node", [CLI_PATH, ...args], { cwd: ROOT, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function realVersion(): string {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

test("the real repository has all three version files agreeing, and exits 0", () => {
  const result = runCli([]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, new RegExp(`all agree on ${realVersion()}`));
});

test("--check on the real repository exits 0 and reports no problems", () => {
  const result = runCli(["--check"]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /no problems found/);
});

test("an unknown argument exits 2", () => {
  const result = runCli(["--bogus"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument/);
});
