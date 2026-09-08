// Tests for scripts/tally-report.ts. Every test spawns the CLI as a real
// subprocess: stdout, stderr, and exit code are the contract, never an
// internal function's return value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI_PATH = join(ROOT, "scripts", "tally-report.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[] = [], cwd: string = ROOT): RunResult {
  const result = spawnSync("node", [CLI_PATH, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const HEADER = "| # | Date | Rule | Where to see it | What it caught |";
const SEPARATOR = "|---|------|------|------|----------------|";

function withTempFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-tally-report-test-"));
  const path = join(dir, "tally.md");
  try {
    writeFileSync(path, content);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the real tally -------------------------------------------------------

test("the real docs/gate-tally.md reports 33 entries and exits 0", () => {
  const result = runCli([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /total entries: 33/);
});

test("--check on the real tally exits 0", () => {
  const result = runCli(["--check"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no problems found/);
});

test("--format json on the real tally parses and carries the total", () => {
  const result = runCli(["--format", "json"]);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.total, 33);
});

test("running from a subfolder gives the same answer as from the root", () => {
  const fromRoot = runCli([]);
  const fromSubfolder = runCli([], join(ROOT, "rules"));
  assert.equal(fromSubfolder.status, 0);
  assert.equal(fromSubfolder.stdout, fromRoot.stdout);
});

// --- a broken file ----------------------------------------------------------

test("--check on a broken file exits 1 and names the row", () => {
  withTempFile(
    [
      HEADER,
      SEPARATOR,
      "| 1 | 2026-01-01 | not-a-real-rule | `docs/gate-tally.md` | it caught something |",
    ].join("\n"),
    (path) => {
      const result = runCli(["--tally", path]);
      assert.notEqual(result.status, 0);
      const checked = runCli(["--tally", path, "--check"]);
      assert.equal(checked.status, 1);
      assert.match(checked.stdout, /row 3/);
      assert.match(checked.stdout, /not-a-real-rule/);
    },
  );
});

// --- error paths, exit 2 -----------------------------------------------------

test("a missing --tally path exits 2", () => {
  const result = runCli(["--tally", join(ROOT, "does", "not", "exist.md")]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /tally-report:/);
});

test("a file with no table exits 2", () => {
  withTempFile("Just some prose, no table anywhere in this file.\n", (path) => {
    const result = runCli(["--tally", path]);
    assert.equal(result.status, 2);
  });
});

test("an unknown argument exits 2", () => {
  const result = runCli(["--bogus"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument/);
});

test("--help exits 0 and prints usage", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: tally-report/);
});
