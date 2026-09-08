// Tests for bin/adg.ts, the one binary this package installs. It is spawned
// as a real subprocess, through its own shebang, the way an installed copy
// would actually be invoked: the executable bit and #!/usr/bin/env node line
// are as much a part of its contract as any exit code.
//
// The most important thing this file checks is that the wrapper never
// flattens an exit code. This package's whole reason to exist is that a
// gate must block, so a dispatcher that turns every wrapped tool's exit
// code into 0 would make every gate it wraps a silent pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const BIN = join(REPO_ROOT, "bin", "adg.ts");
const PACKAGE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], options: { cwd?: string; input?: string } = {}): Run {
  const r = spawnSync(BIN, args, {
    encoding: "utf8",
    cwd: options.cwd,
    input: options.input ?? "",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withTempFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-cli-test-"));
  const path = join(dir, "diff.patch");
  try {
    writeFileSync(path, content);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- help and version ------------------------------------------------------

test("no subcommand: prints help, exits 0", () => {
  const result = runCli([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: agent-delivery-gates/);
  assert.match(result.stdout, /init \[options\]/);
});

test("--help: prints help, exits 0", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: agent-delivery-gates/);
});

test("--version: prints the version from package.json, exits 0", () => {
  const result = runCli(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), PACKAGE_JSON.version);
});

// --- unknown subcommand ------------------------------------------------------

test("unknown subcommand: exits 2, does not run anything", () => {
  const result = runCli(["not-a-real-command"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'not-a-real-command'/);
});

// --- exit code passthrough: the core contract -------------------------------
//
// Each of these gives the wrapped tool an input that makes it exit 1 (a
// finding, a signal) and a separate input that makes it exit 2 (it could
// not run as asked). The wrapper must return the same code either way.

test("validate-report: exit 2 on empty input passes through", () => {
  const result = runCli(["validate-report"], { input: "" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /the report is empty/);
});

test("validate-report: exit 1 on a report with findings passes through", () => {
  const result = runCli(["validate-report"], { input: "no findings section, no commit line\n" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /finding-list-incomplete/);
});

const SIGNAL_DIFF = [
  "diff --git a/tests/widget.test.ts b/tests/widget.test.ts",
  "index 1111111..2222222 100644",
  "--- a/tests/widget.test.ts",
  "+++ b/tests/widget.test.ts",
  "@@ -1,2 +1,1 @@",
  "-expect(sum(1, 2)).toBe(3);",
  "",
].join("\n");

test("test-diff: exit 1 on a diff carrying a weakening signal passes through", () => {
  withTempFile(SIGNAL_DIFF, (path) => {
    const result = runCli(["test-diff", "--diff", path]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /assertion-removed/);
  });
});

test("test-diff: exit 2 on an unreadable diff path passes through", () => {
  const result = runCli(["test-diff", "--diff", "/no/such/path/here.patch"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not read diff file/);
});

test("scan-prose: exit 1 on a file carrying banned prose passes through", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-cli-scan-test-"));
  try {
    const rulesPath = join(dir, "rules.txt");
    writeFileSync(rulesPath, "banana\n");
    const filePath = join(dir, "notes.txt");
    // Built by concatenation so this source file itself never contains an
    // unbroken match for the rule it is exercising.
    writeFileSync(filePath, "a " + "ban" + "ana split\n");
    const result = runCli(["scan-prose", "--rules", rulesPath, filePath]);
    assert.equal(result.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan-prose: exit 2 on a missing rules file passes through", () => {
  const result = runCli(["scan-prose", "--rules", "/no/such/rules.txt"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not exist/);
});

test("tally: exit 2 on a missing tally file passes through", () => {
  const result = runCli(["tally", "--tally", "/no/such/tally.md"], { cwd: REPO_ROOT });
  assert.equal(result.status, 2);
});

test("tally: exit 0 on this repository's own sound tally passes through", () => {
  const result = runCli(["tally", "--check"], { cwd: REPO_ROOT });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no problems found/);
});

// --- init reached through the dispatcher ------------------------------------

test("init reached through the dispatcher writes files and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-cli-init-test-"));
  try {
    const result = runCli(["init", "--dir", dir]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /created: AGENTS\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: unknown argument exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-cli-init-badarg-test-"));
  try {
    const result = runCli(["init", "--dir", dir, "--not-a-real-flag"]);
    assert.equal(result.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
