// Tests for hooks/test-diff-post-tool-hook.ts. Every test spawns the hook
// as a real subprocess with JSON on stdin, the same way Claude Code invokes
// a PostToolUse hook, and asserts on exit code and stderr.
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
const HOOK_PATH = join(HERE, "..", "hooks", "test-diff-post-tool-hook.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHook(input: unknown, cwd?: string, env?: Record<string, string>): RunResult {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  const result = spawnSync("node", [HOOK_PATH], {
    input: stdin,
    encoding: "utf8",
    cwd,
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-test-diff-hook-test-"));
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

test("a non-Bash tool call with no command at all: exits 0", () => {
  const result = runHook({ tool_name: "Write", tool_input: { file_path: "x" }, cwd: process.cwd() });
  assert.equal(result.status, 0);
});

// The contract this file exists to prove: a gate keyed on Claude Code's own
// tool name protects nothing under an agent whose commit tool is called
// something else. This hook keys on the command text instead, so it must
// still fire on a commit run through a non-"Bash" tool name, and even on a
// payload naming no tool at all.
test("a commit run through a non-Bash tool name: still fires", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/widget.test.ts", "expect(sum(1, 2)).toBe(3);\n");
    writeFileSync(join(dir, "tests/widget.test.ts"), "\n");
    runGit(dir, ["add", "tests/widget.test.ts"]);
    runGit(dir, ["commit", "-q", "-m", "remove the assertion"]);
    const result = runHook({ tool_name: "shell", tool_input: { command: "git commit -m 'x'" }, cwd: dir });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /assertion-removed/);
  });
});

test("a commit with no tool_name at all: still fires", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/widget.test.ts", "expect(sum(1, 2)).toBe(3);\n");
    writeFileSync(join(dir, "tests/widget.test.ts"), "\n");
    runGit(dir, ["add", "tests/widget.test.ts"]);
    runGit(dir, ["commit", "-q", "-m", "remove the assertion"]);
    const result = runHook({ tool_input: { command: "git commit -m 'x'" }, cwd: dir });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /assertion-removed/);
  });
});

// A non-Bash tool name whose command is not a commit still exits 0: the
// widened matching is on the command text, not on accepting every tool.
test("a non-Bash tool call whose command is not a commit: exits 0", () => {
  const result = runHook({ tool_name: "shell", tool_input: { command: "npm test" }, cwd: process.cwd() });
  assert.equal(result.status, 0);
});

test("a Bash call that is not a commit: exits 0", () => {
  const result = runHook({ tool_name: "Bash", tool_input: { command: "npm test" }, cwd: process.cwd() });
  assert.equal(result.status, 0);
});

test("a commit with a weakening signal: exits 2 with the report on stderr", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/widget.test.ts", "expect(sum(1, 2)).toBe(3);\n");
    writeFileSync(join(dir, "tests/widget.test.ts"), "\n");
    runGit(dir, ["add", "tests/widget.test.ts"]);
    runGit(dir, ["commit", "-q", "-m", "remove the assertion"]);
    const result = runHook({ tool_name: "Bash", tool_input: { command: "git commit -m 'x'" }, cwd: dir });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /assertion-removed/);
  });
});

test("a commit with no weakening signal: exits 0", () => {
  withTempRepo((dir) => {
    commitFile(dir, "src/widget.ts", "return a + b;\n");
    writeFileSync(join(dir, "src/widget.ts"), "return a - b;\n");
    runGit(dir, ["add", "src/widget.ts"]);
    runGit(dir, ["commit", "-q", "-m", "fix the sign"]);
    const result = runHook({ tool_name: "Bash", tool_input: { command: "git commit -m 'x'" }, cwd: dir });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("malformed JSON on stdin: exits 2", () => {
  const result = runHook("{not json", process.cwd());
  assert.equal(result.status, 2);
});

// A payload of literal null parses, then throws on the first property read,
// which exited 1 with a stack trace. A hook must only ever exit on a code it
// defines, since an undefined code is read as a non-blocking error.
test("a payload of literal null exits 2, not on an uncaught error", () => {
  const r = runHook("null");
  assert.equal(r.status, 2);
});

// A command chained with no space before git is still a commit. Dropping one
// character from the separator class is invisible to every other test.
test("a commit chained with no space before git is recognised", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/widget.test.ts", "expect(sum(1, 2)).toBe(3);\n");
    writeFileSync(join(dir, "tests/widget.test.ts"), "\n");
    runGit(dir, ["add", "tests/widget.test.ts"]);
    runGit(dir, ["commit", "-q", "-m", "remove the assertion"]);
    const result = runHook(
      { tool_name: "Bash", tool_input: { command: "true&git commit -m x" }, cwd: dir },
      dir,
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /assertion-removed/);
  });
});

// --- an operational failure past config validation still exits 2, not 1 -----

// Each fragment is a valid regex alone, which is all config load-time
// validation checks; the two only collide once compiled together into one
// bucket regex, which happens inside separateTestDiff, called from this
// hook's main() after it has already awaited warmLanguageServices. With no
// `.catch` on that call, this used to reach Node's own unhandled-rejection
// handling: exit 1, with a raw stack trace on stderr, a code this hook does
// not document. The documented contract is exit 2 for a signal or any
// operational failure.
test("a config that only breaks once compiled exits 2, not 1, with no raw stack trace", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".adg"), { recursive: true });
    writeFileSync(
      join(dir, ".adg", "test-diff.json"),
      '{"skips": {"add": ["(?<dup>paused)", "(?<dup>halted)"]}}',
    );
    runGit(dir, ["add", ".adg/test-diff.json"]);
    runGit(dir, ["commit", "-q", "-m", "add config"]);
    commitFile(dir, "src/widget.ts", "return a + b;\n");
    writeFileSync(join(dir, "src/widget.ts"), "return a - b;\n");
    runGit(dir, ["add", "src/widget.ts"]);
    runGit(dir, ["commit", "-q", "-m", "fix the sign"]);
    const result = runHook({ tool_name: "Bash", tool_input: { command: "git commit -m 'x'" }, cwd: dir });
    assert.equal(result.status, 2, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.notEqual(result.stderr.trim(), "");
    assert.doesNotMatch(result.stderr, /at compileFragments|at separateTestDiff/, "stderr must not be a raw stack trace");
  });
});

// --- Finding 2: a grammar load failure must be loud here too -----------

// This hook is the actual PostToolUse gate wired into this project's own
// Claude Code settings, a second production entry point reading
// separateTestDiffWarmed's result besides src/agent-adapter.ts's
// runTestDiffGate. Before this fix it read result.signals without ever
// checking whether a registered extension's grammar had failed to load,
// so a Python (or any tree-sitter-backed language) commit whose grammar
// could not be trusted was scanned with the regex fallback and let
// through silently. ADG_TEST_FORCE_GRAMMAR_FAILURE (see src/code-mask.ts)
// reaches the same "load failed" path a missing devDependency would,
// without touching node_modules; a subprocess is required because that
// variable is read once at module load.
const DOCSTRING_SOURCE = [
  "def test_discount():",
  '    """',
  "    Compute the discount. True and False are the boolean literals,",
  "    and 'and'/'or' are the connectives, kept here on purpose.",
  '    """',
  "    assert discount(100, True) == 90",
  "",
].join("\n");

test("Finding 2: a .py commit whose grammar failed to load exits 2, naming the failure", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/test_discount.py", DOCSTRING_SOURCE);
    writeFileSync(join(dir, "tests/test_discount.py"), `${DOCSTRING_SOURCE}\n`);
    runGit(dir, ["add", "tests/test_discount.py"]);
    runGit(dir, ["commit", "-q", "-m", "touch the docstring file"]);
    const result = runHook(
      { tool_name: "Bash", tool_input: { command: "git commit -m 'x'" }, cwd: dir },
      dir,
      { ADG_TEST_FORCE_GRAMMAR_FAILURE: ".py" },
    );
    assert.equal(result.status, 2, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /grammar failed to load/);
    assert.match(result.stderr, /\.py/);
    assert.match(result.stderr, /unmeasured, not as clean/);
  });
});

test("Finding 2: the same commit with no forced failure is scanned normally (control)", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/test_discount.py", DOCSTRING_SOURCE);
    writeFileSync(join(dir, "tests/test_discount.py"), `${DOCSTRING_SOURCE}\n`);
    runGit(dir, ["add", "tests/test_discount.py"]);
    runGit(dir, ["commit", "-q", "-m", "touch the docstring file"]);
    const result = runHook({ tool_name: "Bash", tool_input: { command: "git commit -m 'x'" }, cwd: dir }, dir);
    assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });
});

// --- Finding 3, corrected: wholeFileMaskFallbackCount warns here now -------
//
// This hook used to be an enforcing gate for this condition (exit 2),
// unlike the standalone CLI, which only warns. A fake `git` that answers
// every `git show <rev>:<path>` call -- the exact call
// src/git-blob-reader.ts's makeGitWholeFileReader makes -- with content the
// diff never carries reproduces the misconfigured-git-plumbing case
// Finding 3 names. The whole-file reader itself is safe (see maskDiffLine's
// own raw-text check in src/test-diff-separator.ts) -- it only ever detects
// less well -- so this is now treated the same as grammarAbsentExtensions:
// an environment fact, not a defect in the commit, so it warns and the
// commit goes through, matching the standalone CLI and the MCP server.

test(
  "Finding 3, corrected: a stale whole-file reader warns here now, matching the standalone CLI's warn-only policy",
  {
    skip:
      process.platform === "win32"
        ? "a same-named extension-less script cannot shadow git.exe in PATH resolution on Windows"
        : false,
  },
  () => {
    const realGit = spawnSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" })
      .stdout.trim()
      .split("\n")[0];
    const binDir = mkdtempSync(join(tmpdir(), "adg-test-diff-hook-stale-show-"));
    const fakeGitPath = join(binDir, "git");
    writeFileSync(
      fakeGitPath,
      `#!/bin/sh\nif [ "$1" = "show" ]; then\n  echo "stale content the diff never carries"\n  exit 0\nfi\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(fakeGitPath, 0o755);
    try {
      withTempRepo((dir) => {
        // A test file edited in a way that trips no signal of its own, so
        // the only thing that could make this exit non-zero is the stale
        // reader itself, which it no longer does.
        commitFile(dir, "tests/widget.test.ts", "const label = 'a';\n");
        writeFileSync(join(dir, "tests/widget.test.ts"), "const label = 'b';\n");
        runGit(dir, ["add", "tests/widget.test.ts"]);
        runGit(dir, ["commit", "-q", "-m", "change the label"]);

        const result = runHook({ tool_name: "Bash", tool_input: { command: "git commit -m 'x'" }, cwd: dir }, dir, {
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        });
        assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
        assert.match(result.stderr, /masked one at a time/);
        assert.match(result.stderr, /not blocking this commit/i);
      });
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  },
);

// --- Finding 1: a submodule pointer (a gitlink) has no blob `git show
// <rev>:<path>` can read -- "fatal: bad object" -- which is an ordinary
// git state (a dependency bot bumping a submodule does this routinely),
// not a misconfigured environment. Both adding a submodule and bumping an
// existing one must warn, not block.

test("Finding 1: adding a submodule warns here, not blocks", () => {
  withTempRepo((dir) => {
    const subDir = mkdtempSync(join(tmpdir(), "adg-test-diff-hook-submodule-"));
    runGit(subDir, ["init", "-q"]);
    runGit(subDir, ["config", "user.email", "test@example.invalid"]);
    runGit(subDir, ["config", "user.name", "Test"]);
    writeFileSync(join(subDir, "a.txt"), "hi\n");
    runGit(subDir, ["add", "a.txt"]);
    runGit(subDir, ["commit", "-q", "-m", "init"]);
    const subSha = runGit(subDir, ["rev-parse", "HEAD"]).trim();

    try {
      mkdirSync(join(dir, "tests"), { recursive: true });
      runGit(dir, ["update-index", "--add", "--cacheinfo", `160000,${subSha},tests/sub`]);
      runGit(dir, ["commit", "-q", "--no-verify", "-m", "add submodule"]);

      const result = runHook({ tool_name: "Bash", tool_input: { command: "git commit -m 'x'" }, cwd: dir }, dir);
      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /masked one at a time/);
      assert.match(result.stderr, /not blocking this commit/i);
    } finally {
      rmSync(subDir, { recursive: true, force: true });
    }
  });
});

test("Finding 1: bumping an existing submodule pointer warns here, not blocks", () => {
  withTempRepo((dir) => {
    const subDir = mkdtempSync(join(tmpdir(), "adg-test-diff-hook-submodule-bump-"));
    runGit(subDir, ["init", "-q"]);
    runGit(subDir, ["config", "user.email", "test@example.invalid"]);
    runGit(subDir, ["config", "user.name", "Test"]);
    writeFileSync(join(subDir, "a.txt"), "hi\n");
    runGit(subDir, ["add", "a.txt"]);
    runGit(subDir, ["commit", "-q", "-m", "init"]);
    const subSha1 = runGit(subDir, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(subDir, "a.txt"), "hi again\n");
    runGit(subDir, ["add", "a.txt"]);
    runGit(subDir, ["commit", "-q", "-m", "second"]);
    const subSha2 = runGit(subDir, ["rev-parse", "HEAD"]).trim();

    try {
      mkdirSync(join(dir, "tests"), { recursive: true });
      runGit(dir, ["update-index", "--add", "--cacheinfo", `160000,${subSha1},tests/sub`]);
      runGit(dir, ["commit", "-q", "--no-verify", "-m", "add submodule"]);
      runGit(dir, ["update-index", "--add", "--cacheinfo", `160000,${subSha2},tests/sub`]);
      runGit(dir, ["commit", "-q", "--no-verify", "-m", "bump submodule"]);

      const result = runHook({ tool_name: "Bash", tool_input: { command: "git commit -m 'x'" }, cwd: dir }, dir);
      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /masked one at a time/);
      assert.match(result.stderr, /not blocking this commit/i);
    } finally {
      rmSync(subDir, { recursive: true, force: true });
    }
  });
});
