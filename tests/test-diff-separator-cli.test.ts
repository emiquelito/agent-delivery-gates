// Tests for hooks/test-diff-separator.ts. Every test spawns the CLI as a
// real subprocess and asserts on exit code and stdout/stderr, the contract
// any caller actually sees, never an internal function's return value.
//
// Git fixtures live under a fresh directory in os.tmpdir() per test and are
// removed afterward. Nothing here ever touches this repository's own tree.
//
// adg-test-diff: fixtures
// This file holds diff text written to look like a weakening, so the CLI
// can be run against it; the signals it trips are never real.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
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

test(
  "--diff naming an unreadable file: exit 2",
  {
    // Windows has no POSIX permission bits: chmodSync(path, 0o000) there
    // only ever toggles the read-only attribute, which blocks a write, not
    // a read, so the file stays readable and the exit-2 branch this test
    // checks would never be reached. Skipped for that stated reason, not
    // to make the Windows job green.
    skip: process.platform === "win32" ? "chmod 0o000 does not make a file unreadable on Windows" : false,
  },
  () => {
    withTempFile(SIGNAL_DIFF, (path) => {
      chmodSync(path, 0o000);
      try {
        const result = runCli({ args: ["--diff", path] });
        assert.equal(result.status, 2);
      } finally {
        chmodSync(path, 0o644);
      }
    });
  },
);

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

// --- --classify ---------------------------------------------------------------

test("--classify prints test or source for each path, and exits 0 even with no matches", () => {
  const result = runCli({ args: ["--classify", "tests/widget.test.ts", "src/widget.ts"] });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^tests\/widget\.test\.ts: test\b/);
  assert.match(lines[1], /^src\/widget\.ts: source\b/);
});

test("--classify names the testPaths rule that decided a test path", () => {
  const result = runCli({ args: ["--classify", "tests/widget.test.ts"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /matched testPaths rule:/);
});

test("--classify says no rule matched for a source path", () => {
  const result = runCli({ args: ["--classify", "src/widget.ts"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no testPaths rule matched/);
});

test("--classify with no path argument: exit 2", () => {
  const result = runCli({ args: ["--classify"] });
  assert.equal(result.status, 2);
});

test("--classify combined with --staged: exit 2, only one mode at a time", () => {
  const result = runCli({ args: ["--classify", "src/widget.ts", "--staged"] });
  assert.equal(result.status, 2);
});

test("--classify --format json prints a parseable array naming the matched rule", () => {
  const result = runCli({ args: ["--classify", "tests/widget.test.ts", "--format", "json"] });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed[0].path, "tests/widget.test.ts");
  assert.equal(parsed[0].classification, "test");
  assert.ok(typeof parsed[0].matchedRule === "string");
});

// --- --config, ADG_TEST_DIFF_CONFIG, and .adg/test-diff.json ------------------

function withConfigFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-test-diff-cli-config-test-"));
  const path = join(dir, "test-diff.json");
  try {
    writeFileSync(path, content);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("--config add extends the defaults: a custom test path classifies as a test", () => {
  withConfigFile('{"testPaths": {"add": ["\\\\.flow\\\\.ts$"]}}', (configPath) => {
    const result = runCli({ args: ["--classify", "e2e/checkout.flow.ts", "--config", configPath] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /: test\b/);
  });
});

test("--config replace discards the defaults: an ordinary tests/ path stops classifying as a test", () => {
  withConfigFile('{"testPaths": {"replace": ["\\\\.flow\\\\.ts$"]}}', (configPath) => {
    const result = runCli({ args: ["--classify", "tests/widget.test.ts", "--config", configPath] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /: source\b/);
  });
});

test("an unknown top-level key in the config: exit 2", () => {
  withConfigFile('{"bogus": {"add": []}}', (configPath) => {
    const result = runCli({ args: ["--classify", "src/widget.ts", "--config", configPath] });
    assert.equal(result.status, 2);
    assert.notEqual(result.stderr.trim(), "");
  });
});

test("malformed JSON in the config: exit 2", () => {
  withConfigFile("{not json", (configPath) => {
    const result = runCli({ args: ["--classify", "src/widget.ts", "--config", configPath] });
    assert.equal(result.status, 2);
  });
});

test("a bad regex fragment in the config: exit 2", () => {
  withConfigFile('{"skips": {"add": ["(unclosed"]}}', (configPath) => {
    const result = runCli({ args: ["--classify", "src/widget.ts", "--config", configPath] });
    assert.equal(result.status, 2);
  });
});

test("a nonexistent --config path: exit 2, never a silent fall back to the defaults", () => {
  const result = runCli({ args: ["--classify", "src/widget.ts", "--config", "/nonexistent/does-not-exist-adg.json"] });
  assert.equal(result.status, 2);
});

test("--config beats ADG_TEST_DIFF_CONFIG when both are given", () => {
  withConfigFile('{"testPaths": {"add": ["\\\\.flow\\\\.ts$"]}}', (configPath) => {
    withConfigFile('{"bogus": {"add": []}}', (badEnvPath) => {
      // The env var alone points at a config that would fail to load; the
      // explicit --config path must win instead of that failure showing up.
      const result = runCli({
        args: ["--classify", "e2e/checkout.flow.ts", "--config", configPath],
        env: { ADG_TEST_DIFF_CONFIG: badEnvPath },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /: test\b/);
    });
  });
});

test("ADG_TEST_DIFF_CONFIG applies when no --config is given", () => {
  withConfigFile('{"testPaths": {"add": ["\\\\.flow\\\\.ts$"]}}', (configPath) => {
    const result = runCli({
      args: ["--classify", "e2e/checkout.flow.ts"],
      env: { ADG_TEST_DIFF_CONFIG: configPath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /: test\b/);
  });
});

test("a config broadens what the diff separator itself sees, not only --classify", () => {
  withConfigFile('{"skips": {"add": ["\\\\bpaused\\\\("]}}', (configPath) => {
    const diff = [
      "diff --git a/tests/widget.test.ts b/tests/widget.test.ts",
      "index 1111111..2222222 100644",
      "--- a/tests/widget.test.ts",
      "+++ b/tests/widget.test.ts",
      "@@ -1,1 +1,1 @@",
      "+  paused(reason);",
      "",
    ].join("\n");
    withTempFile(diff, (diffPath) => {
      const result = runCli({ args: ["--diff", diffPath, "--config", configPath] });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /skip-added/);
    });
  });
});

// --- an operational failure past config validation still exits 2 -------------

// Each fragment here is a valid regex by itself, which is all
// validateFragments in src/test-diff-config.ts checks at load time; --config
// and --classify both pass with this file. Joined into one bucket regex by
// compileFragments, which only ever runs once separateTestDiff actually runs,
// two fragments naming the same capture group collide: "Duplicate capture
// group name". That throw happens after main() in hooks/test-diff-separator.ts
// has already awaited warmLanguageServices, so with no `.catch` on the call to
// main() it used to reach Node's own unhandled-rejection handling: exit 1,
// with a raw stack trace on stderr, a code this tool does not document. The
// documented contract is exit 2 for anything that could not run as asked.
const DUPLICATE_CAPTURE_GROUP_CONFIG = '{"skips": {"add": ["(?<dup>paused)", "(?<dup>halted)"]}}';

test("a config that only breaks once compiled, not at load time, still exits 2, not 1", () => {
  withConfigFile(DUPLICATE_CAPTURE_GROUP_CONFIG, (configPath) => {
    const diff = [
      "diff --git a/tests/widget.test.ts b/tests/widget.test.ts",
      "index 1111111..2222222 100644",
      "--- a/tests/widget.test.ts",
      "+++ b/tests/widget.test.ts",
      "@@ -1,1 +1,1 @@",
      "+  x();",
      "",
    ].join("\n");
    withTempFile(diff, (diffPath) => {
      const result = runCli({ args: ["--diff", diffPath, "--config", configPath] });
      assert.equal(result.status, 2, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.notEqual(result.stderr.trim(), "");
      assert.doesNotMatch(result.stderr, /at compileFragments|at separateTestDiff/, "stderr must not be a raw stack trace");
    });
  });
});

// Git reports a rename as a whole file added and a whole file deleted unless
// it is asked to detect renames. Without that, the check that a test file
// left the naming convention never sees a rename at all, and the one case it
// exists for reads as an ordinary pair of file changes. The unit tests pass
// on a diff written with rename headers, so only a real repository catches
// this.
// --- Rust: wide (-U30) re-run for classification only -------------------------
//
// Default git context is 3 lines. A .rs file's #[cfg(test)] module opener
// can sit further than that from the line that actually changed; the CLI
// re-runs the same git invocation with -U30 for classification only (see
// widerClassificationSignals in hooks/test-diff-separator.ts) so brace
// matching in src/test-diff-separator.ts can still find the module.

test("a .rs change the narrow (-U3) diff cannot see as a signal is caught once the wide re-run is added: exit 1, skip-added reported", () => {
  withTempRepo((dir) => {
    const before = [
      "#[cfg(all(test, feature = \"flaky\"))]",
      "mod tests {",
      "    use super::*;",
      "",
      "    // padding so the module opener sits well outside a 3-line",
      "    // context window around the change below, but still inside",
      "    // a 30-line one.",
      "    // line 1",
      "    // line 2",
      "    // line 3",
      "    // line 4",
      "    // line 5",
      "    // line 6",
      "    // line 7",
      "    // line 8",
      "",
      "    fn applies_discount() {",
      "        let result = discount(120);",
      "        let expected = 110;",
      "        result == expected",
      "    }",
      "}",
      "",
    ].join("\n");
    const after = before.replace("    fn applies_discount() {", "    #[ignore]\n    fn applies_discount() {");
    commitFile(dir, "src/pricing.rs", before);
    writeFileSync(join(dir, "src/pricing.rs"), after);
    runGit(dir, ["add", "src/pricing.rs"]);
    runGit(dir, ["commit", "-q", "-m", "add ignore"]);

    // Sanity check: the narrow default-context diff really does not carry
    // the signal on its own (confirms the fixture actually needs the wide
    // re-run, and not because the assertion below passes for an unrelated
    // reason).
    const narrow = spawnSync("git", ["diff-tree", "-p", "--no-color", "--root", "-r", "--find-renames", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout;
    assert.doesNotMatch(narrow, /#\[cfg\(all\(test/, "fixture is invalid: the opener leaked into the narrow diff");

    const result = runCli({ args: ["--rev", "HEAD"], cwd: dir });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /skip-added/);
  });
});

test("the wide re-run never changes the printed source file stats: a plain source-only .rs change still shows the narrow diff's own counts", () => {
  withTempRepo((dir) => {
    commitFile(dir, "src/pricing.rs", "fn discount(cents: i64) -> i64 {\n    cents - 10\n}\n");
    writeFileSync(join(dir, "src/pricing.rs"), "fn discount(cents: i64) -> i64 {\n    cents - 20\n}\n");
    runGit(dir, ["add", "src/pricing.rs"]);
    runGit(dir, ["commit", "-q", "-m", "change the discount"]);

    const result = runCli({ args: ["--rev", "HEAD"], cwd: dir });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /src\/pricing\.rs\s+\+1 -1/);
  });
});

test(
  "a git failure on the wide re-run degrades quietly to the narrow result, not a crash",
  {
    // The fake `git` below is a POSIX shell script with no file extension.
    // Windows resolves a bare command name on PATH by trying each
    // extension in PATHEXT (.exe, .cmd, .bat, ...); an extension-less file
    // named exactly "git" is never one of those candidates, so Windows
    // skips it and keeps searching PATH until it finds the real git.exe
    // elsewhere. The override never takes effect there, so this is
    // skipped for that stated reason, not left to silently test
    // nothing.
    skip:
      process.platform === "win32"
        ? "a same-named extension-less script cannot shadow git.exe in PATH resolution on Windows"
        : false,
  },
  () => {
  // A fake `git` on PATH that behaves exactly like the real one, except it
  // fails any invocation carrying -U30. The CLI's first (narrow) git call
  // never passes -U30, so it succeeds as normal; only the wide re-run
  // reaches the fake failure, and the CLI must still exit cleanly on the
  // narrow result instead of crashing or exiting 2.
  const realGit = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")[0];
  const binDir = mkdtempSync(join(tmpdir(), "adg-test-diff-fake-git-"));
  const fakeGitPath = join(binDir, "git");
  writeFileSync(
    fakeGitPath,
    `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "-U30" ]; then\n    exit 1\n  fi\ndone\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(fakeGitPath, 0o755);

  try {
    withTempRepo((dir) => {
      commitFile(dir, "src/pricing.rs", "fn discount(cents: i64) -> i64 {\n    cents - 10\n}\n");
      writeFileSync(join(dir, "src/pricing.rs"), "fn discount(cents: i64) -> i64 {\n    cents - 20\n}\n");
      runGit(dir, ["add", "src/pricing.rs"]);
      runGit(dir, ["commit", "-q", "-m", "change the discount"]);

      const result = runCli({
        args: ["--rev", "HEAD"],
        cwd: dir,
        env: { PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /src\/pricing\.rs\s+\+1 -1/);
    });
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  },
);

test(
  "the wide re-run only ever fires for a diff touching a .rs file: observed through a fake git that logs its argv",
  {
    // Same hazard as the fake-git test above: this fake `git` is also an
    // extension-less POSIX shell script, which Windows' PATH resolution
    // never matches against a bare "git" lookup, so the override does not
    // take effect there. Skipped for that stated reason.
    skip:
      process.platform === "win32"
        ? "a same-named extension-less script cannot shadow git.exe in PATH resolution on Windows"
        : false,
  },
  () => {
  // A fake `git` on PATH that appends its argv to a log file and then
  // execs the real git, so the CLI behaves normally but every invocation
  // it makes is on record. -U30 only ever belongs to the wide re-run (see
  // widenContext), so its presence or absence in the log is direct proof
  // of whether that re-run fired, not an inference from reading the code.
  const realGit = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")[0];
  const binDir = mkdtempSync(join(tmpdir(), "adg-test-diff-fake-git-log-"));
  const fakeGitPath = join(binDir, "git");
  const logPath = join(binDir, "argv.log");
  writeFileSync(
    fakeGitPath,
    `#!/bin/sh\necho "$@" >> "${logPath}"\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(fakeGitPath, 0o755);
  const env = { PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` };

  try {
    withTempRepo((dir) => {
      commitFile(dir, "src/util.js", "function add(a, b) {\n  return a + b;\n}\n");
      writeFileSync(join(dir, "src/util.js"), "function add(a, b) {\n  return a - b;\n}\n");
      runGit(dir, ["add", "src/util.js"]);
      runGit(dir, ["commit", "-q", "-m", "change add"]);

      writeFileSync(logPath, "");
      const result = runCli({ args: ["--rev", "HEAD"], cwd: dir, env });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const log = readFileSync(logPath, "utf8");
      assert.doesNotMatch(log, /-U30/, `a non-Rust diff must never trigger the wide re-run; git log was:\n${log}`);
    });

    withTempRepo((dir) => {
      commitFile(dir, "src/pricing.rs", "fn discount(cents: i64) -> i64 {\n    cents - 10\n}\n");
      writeFileSync(join(dir, "src/pricing.rs"), "fn discount(cents: i64) -> i64 {\n    cents - 20\n}\n");
      runGit(dir, ["add", "src/pricing.rs"]);
      runGit(dir, ["commit", "-q", "-m", "change the discount"]);

      writeFileSync(logPath, "");
      const result = runCli({ args: ["--rev", "HEAD"], cwd: dir, env });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const log = readFileSync(logPath, "utf8");
      assert.match(log, /-U30/, `a .rs diff must trigger the wide re-run; git log was:\n${log}`);
    });
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  },
);

test("a signal derivable from both the narrow and the wide diff is reported once, not twice", () => {
  withTempRepo((dir) => {
    // Small enough that the default -U3 context already shows the whole
    // file, so the wide -U30 re-run sees the identical hunk and would
    // derive the identical assertion-weakened signal a second time if
    // dedup were a no-op.
    const before = [
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn applies_discount() {",
      "        let result = discount(120);",
      "        assert_eq!(result, 100);",
      "    }",
      "}",
      "",
    ].join("\n");
    const after = before.replace("assert_eq!(result, 100);", "assert_eq!(result, 110);");
    commitFile(dir, "src/pricing.rs", before);
    writeFileSync(join(dir, "src/pricing.rs"), after);
    runGit(dir, ["add", "src/pricing.rs"]);
    runGit(dir, ["commit", "-q", "-m", "weaken the assertion"]);

    const result = runCli({ args: ["--rev", "HEAD", "--format", "json"], cwd: dir });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const parsed = JSON.parse(result.stdout) as { signals: unknown[]; signalCount: number };
    assert.equal(parsed.signalCount, 1, `expected the signal deduplicated to 1, got:\n${result.stdout}`);
    assert.equal(parsed.signals.length, 1);
  });
});

test("a real git rename out of the test naming convention is reported", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "widget.test.js"), 'test("a", () => { assert.ok(1); });\n');
    runGit(dir, ["add", "-A"]);
    runGit(dir, ["commit", "-q", "-m", "initial"]);
    runGit(dir, ["mv", "widget.test.js", "widget.helper.js"]);
    runGit(dir, ["commit", "-q", "-am", "tidy the test layout"]);

    const result = runCli({ args: ["--rev", "HEAD"], cwd: dir });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /test-file-declassified/);
    assert.match(result.stdout, /widget\.test\.js -> widget\.helper\.js/);
  });
});


// --- The fixtures marker: exempt files are named on every run ------------------
//
// Every test here reads the CLI's own stdout and exit code. A gate that
// skips a file without saying so is the failure this project is built to
// name, so the wording is asserted, not just the exit code.

const MARKER_COMMENT = "// adg-test-diff: fixtures";

/** A test file that trips skip-added, optionally carrying the marker. */
function holderFile(marked: boolean): string {
  const head = marked ? [MARKER_COMMENT, "// fixture text only."] : ["// ordinary test file."];
  return [...head, "test('a', () => {});", "test.skip('b', () => {});", ""].join("\n");
}

function plainFile(marked: boolean): string {
  const head = marked ? [MARKER_COMMENT, "// fixture text only."] : ["// ordinary test file."];
  return [...head, "test('a', () => {});", ""].join("\n");
}

test("a marked file's signals are suppressed and the file is named, on a run with other signals", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/holder.test.ts", plainFile(true));
    commitFile(dir, "tests/other.test.ts", plainFile(false));
    writeFileSync(join(dir, "tests/holder.test.ts"), holderFile(true));
    writeFileSync(join(dir, "tests/other.test.ts"), holderFile(false));
    runGit(dir, ["commit", "-qam", "add skips to both"]);

    const result = runCli({ args: ["--rev", "HEAD"], cwd: dir });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Exempt from signals \(1\), each carrying the "adg-test-diff: fixtures" marker:/);
    assert.match(result.stdout, /^ {2}tests\/holder\.test\.ts$/m);
    assert.match(result.stdout, /Signals \(1\):/);
    assert.match(result.stdout, /skip-added high tests\/other\.test\.ts:/);
    assert.doesNotMatch(result.stdout, /skip-added high tests\/holder\.test\.ts:/);
  });
});

test("a clean run that skipped a file still names it, and says no signals were found", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/holder.test.ts", plainFile(true));
    writeFileSync(join(dir, "tests/holder.test.ts"), holderFile(true));
    runGit(dir, ["commit", "-qam", "add a skip"]);

    const result = runCli({ args: ["--rev", "HEAD"], cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Exempt from signals \(1\), each carrying the "adg-test-diff: fixtures" marker:/);
    assert.match(result.stdout, /^ {2}tests\/holder\.test\.ts$/m);
    assert.match(result.stdout, /Signals: none found\./);
  });
});

test("a clean run that skipped nothing prints no exempt block at all", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/holder.test.ts", plainFile(false));
    writeFileSync(join(dir, "tests/holder.test.ts"), plainFile(false).replace("test('a'", "test('a2'"));
    runGit(dir, ["commit", "-qam", "rename a case"]);

    const result = runCli({ args: ["--rev", "HEAD"], cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Exempt from signals/);
    assert.match(result.stdout, /Signals: none found\./);
  });
});

test("every skipped file is named, not just the first", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/one.test.ts", plainFile(true));
    commitFile(dir, "tests/two.test.ts", plainFile(true));
    writeFileSync(join(dir, "tests/one.test.ts"), holderFile(true));
    writeFileSync(join(dir, "tests/two.test.ts"), holderFile(true));
    runGit(dir, ["commit", "-qam", "add skips to both"]);

    const result = runCli({ args: ["--rev", "HEAD"], cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Exempt from signals \(2\)/);
    assert.match(result.stdout, /^ {2}tests\/one\.test\.ts$/m);
    assert.match(result.stdout, /^ {2}tests\/two\.test\.ts$/m);
  });
});

test("--format json carries the skipped list and its count", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/holder.test.ts", plainFile(true));
    commitFile(dir, "tests/other.test.ts", plainFile(false));
    writeFileSync(join(dir, "tests/holder.test.ts"), holderFile(true));
    writeFileSync(join(dir, "tests/other.test.ts"), holderFile(false));
    runGit(dir, ["commit", "-qam", "add skips to both"]);

    const result = runCli({ args: ["--rev", "HEAD", "--format", "json"], cwd: dir });
    assert.equal(result.status, 1, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.exemptFiles, ["tests/holder.test.ts"]);
    assert.equal(parsed.exemptCount, 1);
    assert.deepEqual(
      parsed.testFiles.map((f: { path: string }) => f.path).sort(),
      ["tests/holder.test.ts", "tests/other.test.ts"],
      "an exempt file is still reported in the test half",
    );
    assert.deepEqual(
      parsed.signals.map((s: { file: string }) => s.file),
      ["tests/other.test.ts"],
    );
  });
});

test("json on a run that skipped nothing carries an empty list and a zero count", () => {
  withTempFile(CLEAN_DIFF, (path) => {
    const result = runCli({ args: ["--diff", path, "--format", "json"] });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.exemptFiles, []);
    assert.equal(parsed.exemptCount, 0);
  });
});

test("the marker is not honoured past the first 20 lines of a file", () => {
  withTempRepo((dir) => {
    const filler = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`);
    const late = [...filler, MARKER_COMMENT, "test('a', () => {});", ""].join("\n");
    const lateWithSkip = [...filler, MARKER_COMMENT, "test('a', () => {});", "test.skip('b', () => {});", ""].join("\n");
    commitFile(dir, "tests/late.test.ts", late);
    writeFileSync(join(dir, "tests/late.test.ts"), lateWithSkip);
    runGit(dir, ["commit", "-qam", "add a skip"]);

    const result = runCli({ args: ["--rev", "HEAD"], cwd: dir });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /Exempt from signals/);
    assert.match(result.stdout, /skip-added high tests\/late\.test\.ts:/);
  });
});

// --- Phase: whole-file mask context, end to end through --rev --------------
//
// The CLI reads the commit's own parent and the commit itself from real
// git (src/git-blob-reader.ts), unlike every other test in this file, which
// only ever hands the separator a diff with no repository behind it at
// all. This is the one test that proves the wiring itself -- not just the
// pure core -- actually reaches into the repository, masks the whole file,
// and changes what the CLI reports.

test("--rev masks a new test file's own template literal as a whole file, not one diff line at a time", () => {
  withTempRepo((dir) => {
    const content = ["const src = `", '  it.skip("x");', "`;", ""].join("\n");
    commitFile(dir, "tests/widget.test.ts", content);

    const result = runCli({ args: ["--rev", "HEAD"], cwd: dir });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(
      result.stdout,
      /skip-added/,
      "the skip lives inside a template literal in the real file; --rev can read that whole file and see it",
    );
  });
});

test("--staged masks a removed assertion against the committed (old) side of the file", () => {
  withTempRepo((dir) => {
    const content = ["const src = `", "  assert.ok(x);", "`;", ""].join("\n");
    commitFile(dir, "tests/widget.test.ts", content);
    writeFileSync(join(dir, "tests/widget.test.ts"), "const src = ``;\n");
    runGit(dir, ["add", "tests/widget.test.ts"]);

    const result = runCli({ args: ["--staged"], cwd: dir });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(
      result.stdout,
      /assertion-removed/,
      "the removed line is fixture text in the committed file it was removed from, read from the old (HEAD) side",
    );
  });
});

// --- Finding 3: wholeFileMaskFallbackCount, end to end through --rev ---------
//
// A fake `git` (same technique as the -U30 fake-git tests above) that
// answers every `git show <rev>:<path>` call -- exactly the call
// src/git-blob-reader.ts's makeGitWholeFileReader makes -- with content the
// diff itself never carries, reproducing the misconfigured-git-plumbing
// case Finding 3 names: a caller that DID supply a reader, but whose
// answers cannot be trusted. Every other git subcommand (diff-tree,
// rev-parse) passes through to the real binary unchanged.

function withStaleShowShim(fn: (binDir: string) => void): void {
  const realGit = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n")[0];
  const binDir = mkdtempSync(join(tmpdir(), "adg-test-diff-stale-show-"));
  const fakeGitPath = join(binDir, "git");
  writeFileSync(
    fakeGitPath,
    `#!/bin/sh\nif [ "$1" = "show" ]; then\n  echo "stale content the diff never carries"\n  exit 0\nfi\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(fakeGitPath, 0o755);
  try {
    fn(binDir);
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

test(
  "wholeFileMaskFallbackCount is non-zero when the whole-file reader's own answers cannot be trusted, and the real signal is still caught through the per-line fallback",
  {
    // Same reason the -U30 fake-git tests above are skipped on Windows: an
    // extension-less POSIX shell script named exactly "git" never matches
    // a bare "git" lookup there.
    skip:
      process.platform === "win32"
        ? "a same-named extension-less script cannot shadow git.exe in PATH resolution on Windows"
        : false,
  },
  () => {
    withStaleShowShim((binDir) => {
      withTempRepo((dir) => {
        commitFile(dir, "tests/widget.test.ts", "expect(sum(1, 2)).toBe(3);\n");
        writeFileSync(join(dir, "tests/widget.test.ts"), "\n");
        runGit(dir, ["add", "tests/widget.test.ts"]);
        runGit(dir, ["commit", "-q", "-m", "remove the assertion"]);

        const result = runCli({
          args: ["--rev", "HEAD", "--format", "json"],
          cwd: dir,
          env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
        });
        // The signal is still found: the safety net this field counts the
        // use of never hides a real removal, it only says the whole-file
        // benefit was lost for it.
        assert.equal(result.status, 1, result.stdout + result.stderr);
        const parsed = JSON.parse(result.stdout);
        assert.ok(
          parsed.wholeFileMaskFallbackCount > 0,
          `expected a non-zero wholeFileMaskFallbackCount, got: ${result.stdout}`,
        );
        assert.match(result.stdout, /"assertion-removed"/);
      });
    });
  },
);

test(
  "wholeFileMaskFallbackCount prints a warning in text format but does not change the exit code on an otherwise clean run",
  {
    skip:
      process.platform === "win32"
        ? "a same-named extension-less script cannot shadow git.exe in PATH resolution on Windows"
        : false,
  },
  () => {
    withStaleShowShim((binDir) => {
      withTempRepo((dir) => {
        // A test file edited in a way that trips no signal of its own (no
        // assertion, skip, or test case touched), so the whole-file reader
        // is still asked for this file (it is a test file, so
        // signalsForTestFile always builds a mask context for it) while
        // nothing else about the run would ever exit non-zero. Any exit
        // code other than 0 would mean this field started blocking the
        // run -- the standalone CLI's own policy (see warningBlock's doc
        // in hooks/test-diff-separator.ts) is to warn, matching
        // unwarmedExtensions, not to fail the way
        // grammarLoadFailedExtensions does.
        commitFile(dir, "tests/widget.test.ts", "const label = 'a';\n");
        writeFileSync(join(dir, "tests/widget.test.ts"), "const label = 'b';\n");
        runGit(dir, ["add", "tests/widget.test.ts"]);
        runGit(dir, ["commit", "-q", "-m", "change the label"]);

        const result = runCli({
          args: ["--rev", "HEAD"],
          cwd: dir,
          env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /Warning: \d+ line\(s\) were masked one at a time/);
      });
    });
  },
);
