// Finding 2 regression: `hadLanguageLoadFailure` (src/code-mask.ts) used to
// be read only by src/mutate.ts. src/agent-adapter.ts's runTestDiffGate
// checked `result.unwarmedExtensions` -- "nobody asked this grammar to
// load yet" -- and never checked whether a grammar was attempted and
// failed to load. Once a real or forced failure cached the fallback
// service for an extension, no later call in the process could see
// `unwarmedExtensions` for it either, so this gate's only safety net could
// not catch it. The result: a Python (or any tree-sitter-backed language)
// commit whose grammar failed to load got scanned with the regex fallback,
// reading a docstring's contents as ordinary code, with no warning at all.
//
// This drives hooks/cursor-hook.ts's `test-diff` gate as a real subprocess
// (not runTestDiffGate in-process) because ADG_TEST_FORCE_GRAMMAR_FAILURE
// (see src/code-mask.ts) is read once at module load: a subprocess is the
// only way to see a fresh load attempt fail, and to keep the permanent
// per-process failure cache from bleeding into any other test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const HOOK_PATH = join(REPO_ROOT, "hooks", "cursor-hook.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHook(gate: string, input: unknown, cwd: string, env?: Record<string, string>): RunResult {
  const result = spawnSync("node", [HOOK_PATH, gate], {
    cwd,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-grammar-load-failure-test-"));
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  runGit(dir, ["add", "a.txt"]);
  runGit(dir, ["commit", "-q", "-m", "add a.txt"]);
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

// A docstring whose contents read as real Python keywords to a masker that
// does not understand Python strings: True, False, and, or. The regex
// scanner's C-family assumptions treat none of these as inside a string
// once the grammar mask that would have hidden the whole docstring is gone.
const DOCSTRING_SOURCE = [
  "def test_discount():",
  '    """',
  "    Compute the discount. True and False are the boolean literals,",
  "    and 'and'/'or' are the connectives, kept here on purpose.",
  '    """',
  "    assert discount(100, True) == 90",
  "",
].join("\n");

test("Finding 2: a .py commit whose grammar failed to load is refused, not silently scanned with the wrong mask", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/test_discount.py", DOCSTRING_SOURCE);
    // A trivial, behavior-preserving edit: only the diff needs to exist and
    // touch a .py file. What matters is whether the gate notices the
    // grammar could not be trusted for it, not what the edit says.
    writeFileSync(join(dir, "tests/test_discount.py"), `${DOCSTRING_SOURCE}\n`);
    runGit(dir, ["add", "tests/test_discount.py"]);
    runGit(dir, ["commit", "-q", "-m", "touch the docstring file"]);

    const result = runHook(
      "test-diff",
      { command: "git commit -m 'x'", cwd: dir, hook_event_name: "afterShellExecution" },
      dir,
      { ADG_TEST_FORCE_GRAMMAR_FAILURE: ".py" },
    );

    // cursor-hook.ts's "error" case exits 2 with the message on stderr
    // (see hooks/cursor-hook.ts): never 0 (which would read as either an
    // ordinary allow or, if it printed deny JSON, an ordinary weakening
    // signal), and never 1 (the one code that fails open in Cursor's
    // terms). A run that could not trust its own mask must be loud, not
    // read as either a clean commit or an unrelated finding.
    assert.equal(result.status, 2, `expected exit 2 (gate error), got ${result.status}: ${result.stdout}`);
    assert.match(result.stderr, /grammar failed to load/);
    assert.match(result.stderr, /Python/);
    assert.match(result.stderr, /unmeasured, not as clean/);
  });
});

test("Finding 2: the same commit with no forced failure is scanned normally (control)", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/test_discount.py", DOCSTRING_SOURCE);
    writeFileSync(join(dir, "tests/test_discount.py"), `${DOCSTRING_SOURCE}\n`);
    runGit(dir, ["add", "tests/test_discount.py"]);
    runGit(dir, ["commit", "-q", "-m", "touch the docstring file"]);

    const result = runHook(
      "test-diff",
      { command: "git commit -m 'x'", cwd: dir, hook_event_name: "afterShellExecution" },
      dir,
    );
    assert.notEqual(result.status, 2, `expected no gate error without the forced failure: ${result.stderr}`);
  });
});
