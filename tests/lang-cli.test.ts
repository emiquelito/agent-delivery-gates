// Tests for `agent-delivery-gates lang`, spawned through bin/adg.ts the same
// way tests/adg-cli.test.ts and tests/init.test.ts spawn every other
// subcommand. Every path exercised here fails before a network fetch would
// ever happen -- an unknown language, a missing argument, --help, and
// `list` -- so this suite, like every other one in this project, makes no
// real network request. A real fetch is exercised against a stubbed
// `globalThis.fetch` in tests/tree-sitter-grammar-store.test.ts instead,
// and end to end (a real download) only by hand, the way this phase's own
// evidence bar asks for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const BIN = join(REPO_ROOT, "bin", "adg.ts");

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Run {
  const [command, commandArgs] =
    process.platform === "win32" ? [process.execPath, [BIN, ...args]] : [BIN, args];
  const r = spawnSync(command, commandArgs, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("lang list: exits 0 and names every known language", () => {
  const result = runCli(["lang", "list"]);
  assert.equal(result.status, 0, result.stderr);
  for (const name of ["python", "rust", "ruby", "php", "go", "java", "csharp"]) {
    assert.match(result.stdout, new RegExp(`^${name}\\t`, "m"), `lang list did not name '${name}'`);
  }
});

test("lang add: an unknown language name fails clearly, exit 2, before anything is fetched", () => {
  const result = runCli(["lang", "add", "cobol"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown language 'cobol'/);
  assert.match(result.stderr, /Known languages:/);
});

test("lang add: naming no language at all is an argument error, not a silent no-op", () => {
  const result = runCli(["lang", "add"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /name at least one language/);
});

test("lang add: a list with one unknown name among known ones fails before installing any of them", () => {
  // If this reached the network it would install python before failing on
  // 'cobol', which is exactly the half-install this command exists to
  // refuse: every name is checked against the known table up front.
  const result = runCli(["lang", "add", "python", "cobol"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown language 'cobol'/);
});

test("lang, with no subcommand, fails clearly instead of doing nothing silently", () => {
  const result = runCli(["lang"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /name a subcommand/);
});

test("lang --help and lang add --help print usage and exit 0", () => {
  const top = runCli(["lang", "--help"]);
  assert.equal(top.status, 0);
  assert.match(top.stdout, /Usage: agent-delivery-gates lang/);

  const add = runCli(["lang", "add", "--help"]);
  assert.equal(add.status, 0);
  assert.match(add.stdout, /Usage: agent-delivery-gates lang/);
});
