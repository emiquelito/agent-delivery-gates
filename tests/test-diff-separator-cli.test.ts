// Tests for hooks/test-diff-separator.ts. Every test spawns the CLI as a
// real subprocess and asserts on exit code and stdout/stderr, the contract
// any caller actually sees, never an internal function's return value.
//
// Git fixtures live under a fresh directory in os.tmpdir() per test and are
// removed afterward. Nothing here ever touches this repository's own tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "..", "hooks", "test-diff-separator.ts");

interface RunOptions {
  args?: string[];
  input?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(options: RunOptions = {}): RunResult {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync("node", [CLI_PATH, ...(options.args ?? [])], {
    input: options.input ?? "",
    encoding: "utf8",
    cwd: options.cwd,
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function withTempFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-test-diff-cli-test-"));
  const path = join(dir, "diff.patch");
  try {
    writeFileSync(path, content);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-test-diff-repo-test-"));
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);
  return dir;
}

function withTempRepo(fn: (dir: string) => void): void {
  const dir = makeTempRepo();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function commitFile(dir: string, name: string, content: string): void {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content);
  runGit(dir, ["add", name]);
  runGit(dir, ["commit", "-q", "-m", `write ${name}`]);
}

const SIGNAL_DIFF = [
  "diff --git a/tests/widget.test.ts b/tests/widget.test.ts",
  "index 1111111..2222222 100644",
  "--- a/tests/widget.test.ts",
  "+++ b/tests/widget.test.ts",
  "@@ -1,2 +1,1 @@",
  "-expect(sum(1, 2)).toBe(3);",
  "",
].join("\n");

const CLEAN_DIFF = [
  "diff --git a/src/widget.ts b/src/widget.ts",
  "index 1111111..2222222 100644",
  "--- a/src/widget.ts",
  "+++ b/src/widget.ts",
  "@@ -1,1 +1,1 @@",
  "-return a + b;",
  "+return a - b;",
  "",
].join("\n");

// --- --diff from a file and from stdin -----------------------------------------

test("--diff from a file with a signal: exit 1, signal id printed", () => {
  withTempFile(SIGNAL_DIFF, (path) => {
    const result = runCli({ args: ["--diff", path] });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /assertion-removed/);
  });
});

test("--diff - reads from stdin", () => {
  const result = runCli({ args: ["--diff", "-"], input: SIGNAL_DIFF });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /assertion-removed/);
});

test("--diff on a source-only change: exit 0, states no test files changed", () => {
  withTempFile(CLEAN_DIFF, (path) => {
    const result = runCli({ args: ["--diff", path] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no test files changed/i);
  });
});

// --- --format json ------------------------------------------------------------

test("--format json produces parseable JSON with the expected fields", () => {
  withTempFile(SIGNAL_DIFF, (path) => {
    const result = runCli({ args: ["--diff", path, "--format", "json"] });
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout);
    assert.ok(Array.isArray(parsed.signals));
    assert.equal(parsed.signals[0].id, "assertion-removed");
    assert.ok(Array.isArray(parsed.testFiles));
    assert.ok(Array.isArray(parsed.sourceFiles));
  });
});

// --- exit codes -----------------------------------------------------------------

test("no test file changed: exit 0", () => {
  withTempFile(CLEAN_DIFF, (path) => {
    const result = runCli({ args: ["--diff", path] });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("a signal found: exit 1", () => {
  withTempFile(SIGNAL_DIFF, (path) => {
    const result = runCli({ args: ["--diff", path] });
    assert.equal(result.status, 1);
  });
});

test("an unknown argument: exit 2", () => {
  const result = runCli({ args: ["--bogus"] });
  assert.equal(result.status, 2);
});

test("more than one diff source given: exit 2", () => {
  const result = runCli({ args: ["--staged", "--range", "a..b"] });
  assert.equal(result.status, 2);
});

test("--diff naming a nonexistent path: exit 2", () => {
  const result = runCli({ args: ["--diff", "/nonexistent/does-not-exist-adg.patch"] });
  assert.equal(result.status, 2);
  assert.notEqual(result.stderr.trim(), "");
});

test("--diff naming an unreadable file: exit 2", () => {
  withTempFile(SIGNAL_DIFF, (path) => {
    chmodSync(path, 0o000);
    try {
      const result = runCli({ args: ["--diff", path] });
      assert.equal(result.status, 2);
    } finally {
      chmodSync(path, 0o644);
    }
  });
});

test("empty --diff input: exit 2, not a pass", () => {
  withTempFile("", (path) => {
    const result = runCli({ args: ["--diff", path] });
    assert.equal(result.status, 2);
  });
});

test("empty stdin with --diff -: exit 2", () => {
  const result = runCli({ args: ["--diff", "-"], input: "" });
  assert.equal(result.status, 2);
});

// --- --rev and --staged against a throwaway repository -------------------------

test("--rev against the last commit in a throwaway repo, with a signal: exit 1", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/widget.test.ts", "expect(sum(1, 2)).toBe(3);\n");
    writeFileSync(join(dir, "tests/widget.test.ts"), "\n");
    runGit(dir, ["add", "tests/widget.test.ts"]);
    runGit(dir, ["commit", "-q", "-m", "remove the assertion"]);
    const result = runCli({ args: ["--rev", "HEAD"], cwd: dir });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /assertion-removed/);
  });
});

test("--rev with no argument given defaults to HEAD", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/widget.test.ts", "expect(sum(1, 2)).toBe(3);\n");
    writeFileSync(join(dir, "tests/widget.test.ts"), "\n");
    runGit(dir, ["add", "tests/widget.test.ts"]);
    runGit(dir, ["commit", "-q", "-m", "remove the assertion"]);
    const result = runCli({ cwd: dir });
    assert.equal(result.status, 1, result.stderr);
  });
});

test("--staged reports the staged diff before any commit", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/widget.test.ts", "expect(sum(1, 2)).toBe(3);\nexpect(1).toBe(1);\n");
    writeFileSync(join(dir, "tests/widget.test.ts"), "expect(1).toBe(1);\n");
    runGit(dir, ["add", "tests/widget.test.ts"]);
    const result = runCli({ args: ["--staged"], cwd: dir });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /assertion-removed/);
  });
});

test("a git failure (not a git repository): exit 2, never 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-test-diff-notgit-test-"));
  try {
    const result = runCli({ args: ["--rev", "HEAD"], cwd: dir });
    assert.equal(result.status, 2);
    assert.notEqual(result.stderr.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- --help -----------------------------------------------------------------

test("--help prints usage and exits 0", () => {
  const result = runCli({ args: ["--help"] });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: test-diff-separator/);
});
