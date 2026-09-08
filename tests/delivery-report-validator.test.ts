// Tests for hooks/delivery-report-validator.ts. Every test spawns the CLI
// as a real subprocess, the vendor-neutral contract this tool exists to
// offer: stdin or --report in, exit code and stdout/stderr out. Never an
// internal function's return value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "..", "hooks", "delivery-report-validator.ts");
const PASSING_FIXTURE_PATH = join(HERE, "fixtures", "passing-report.md");

interface RunOptions {
  args?: string[];
  input?: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(options: RunOptions = {}): RunResult {
  const result = spawnSync("node", [CLI_PATH, ...(options.args ?? [])], {
    input: options.input ?? "",
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function withTempFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-report-validator-test-"));
  const path = join(dir, "report.md");
  try {
    writeFileSync(path, content);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- stdin vs --report --------------------------------------------------------

test("a passing report piped on stdin: exit 0, no findings printed", () => {
  const input = readFileSync(PASSING_FIXTURE_PATH, "utf8");
  const result = runCli({ input });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
});

test("a passing report given by --report: exit 0", () => {
  withTempFile(readFileSync(PASSING_FIXTURE_PATH, "utf8"), (path) => {
    const result = runCli({ args: ["--report", path] });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("a failing report on stdin: exit 1, finding printed to stdout", () => {
  const result = runCli({ input: "# R\n\nThe retry was validated.\n" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /unproven-robustness-claim/);
});

test("findings go to stdout, not stderr", () => {
  const result = runCli({ input: "# R\n\nThe retry was validated.\n" });
  assert.equal(result.stderr.trim(), "");
});

// --- exit codes ---------------------------------------------------------------

test("a nonexistent --report path: exit 2", () => {
  const result = runCli({ args: ["--report", "/nonexistent/does-not-exist-adg.md"] });
  assert.equal(result.status, 2);
  assert.notEqual(result.stderr.trim(), "");
});

test("an unknown argument: exit 2", () => {
  const result = runCli({ args: ["--bogus"], input: "some text" });
  assert.equal(result.status, 2);
});

test("empty stdin input: exit 2, not a pass", () => {
  const result = runCli({ input: "" });
  assert.equal(result.status, 2);
});

test("whitespace-only stdin input: exit 2, not a pass", () => {
  const result = runCli({ input: "   \n\t\n  \n" });
  assert.equal(result.status, 2);
});

// --- --format json --------------------------------------------------------------

test("--format json produces parseable JSON with the expected fields", () => {
  const result = runCli({ args: ["--format", "json"], input: "# R\n\nThe retry was validated.\n" });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed));
  const claim = parsed.find((f: { rule: string }) => f.rule === "unproven-robustness-claim");
  assert.ok(claim, "expected an unproven-robustness-claim finding");
  assert.equal(typeof claim.line, "number");
  assert.equal(typeof claim.severity, "string");
});

test("--format json on a passing report prints an empty array", () => {
  const input = readFileSync(PASSING_FIXTURE_PATH, "utf8");
  const result = runCli({ args: ["--format", "json"], input });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

// --- --help -----------------------------------------------------------------

test("--help prints usage and exits 0", () => {
  const result = runCli({ args: ["--help"] });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage/);
});

// --- --prior ------------------------------------------------------------------

test("--prior with every id carried forward: passes", () => {
  withTempFile("F1\nF2\n", (priorPath) => {
    const input = readFileSync(PASSING_FIXTURE_PATH, "utf8");
    const result = runCli({ args: ["--prior", priorPath], input });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("--prior with a dropped id: fails with R5", () => {
  withTempFile("F1\nF99\n", (priorPath) => {
    const input = readFileSync(PASSING_FIXTURE_PATH, "utf8");
    const result = runCli({ args: ["--prior", priorPath], input });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /open-finding-not-carried/);
    assert.match(result.stdout, /F99/);
  });
});

// --- CRLF and no trailing newline --------------------------------------------

test("CRLF input is handled: a passing report with CRLF endings still exits 0", () => {
  const input = readFileSync(PASSING_FIXTURE_PATH, "utf8").split("\n").join("\r\n");
  const result = runCli({ input });
  assert.equal(result.status, 0, result.stderr);
});

test("input with no trailing newline is handled", () => {
  const input = readFileSync(PASSING_FIXTURE_PATH, "utf8").replace(/\n$/, "");
  const result = runCli({ input });
  assert.equal(result.status, 0, result.stderr);
});
