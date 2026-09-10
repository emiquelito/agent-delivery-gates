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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
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
    assert.equal(result.status, 0, `expected no gate error without the forced failure: ${result.stderr}`);
  });
});

// --- Finding 3, corrected: wholeFileMaskFallbackCount warns in
// src/agent-adapter.ts's runTestDiffGate, driven here through
// hooks/cursor-hook.ts as a real subprocess, instead of blocking. A fake
// `git` that answers every `git show <rev>:<path>` call (the exact call
// src/git-blob-reader.ts's makeGitWholeFileReader makes) with content the
// diff never carries reproduces the misconfigured git plumbing Finding 3
// names. The whole-file reader itself is safe (see maskDiffLine's own
// raw-text check in src/test-diff-separator.ts) -- it only ever detects
// less well -- so this is now treated the same as grammarAbsentExtensions:
// an environment fact, not a defect in the commit, so it warns and the
// commit goes through, matching the standalone CLI and the MCP server.

test(
  "Finding 3, corrected: a stale whole-file reader warns here now, instead of being refused",
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
    const binDir = mkdtempSync(join(tmpdir(), "adg-agent-adapter-stale-show-"));
    const fakeGitPath = join(binDir, "git");
    writeFileSync(
      fakeGitPath,
      `#!/bin/sh\nif [ "$1" = "show" ]; then\n  echo "stale content the diff never carries"\n  exit 0\nfi\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(fakeGitPath, 0o755);
    try {
      withTempRepo((dir) => {
        commitFile(dir, "tests/widget.test.ts", "const label = 'a';\n");
        writeFileSync(join(dir, "tests/widget.test.ts"), "const label = 'b';\n");
        runGit(dir, ["add", "tests/widget.test.ts"]);
        runGit(dir, ["commit", "-q", "-m", "change the label"]);

        const result = runHook(
          "test-diff",
          { command: "git commit -m 'x'", cwd: dir, hook_event_name: "afterShellExecution" },
          dir,
          { PATH: `${binDir}:${process.env.PATH ?? ""}` },
        );
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
    const subDir = mkdtempSync(join(tmpdir(), "adg-agent-adapter-submodule-"));
    runGit(subDir, ["init", "-q"]);
    runGit(subDir, ["config", "user.email", "test@example.invalid"]);
    runGit(subDir, ["config", "user.name", "Test"]);
    writeFileSync(join(subDir, "a.txt"), "hi\n");
    runGit(subDir, ["add", "a.txt"]);
    runGit(subDir, ["commit", "-q", "-m", "init"]);
    const subSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: subDir, encoding: "utf8" }).stdout.trim();

    try {
      mkdirSync(join(dir, "tests"), { recursive: true });
      runGit(dir, ["update-index", "--add", "--cacheinfo", `160000,${subSha},tests/sub`]);
      runGit(dir, ["commit", "-q", "--no-verify", "-m", "add submodule"]);

      const result = runHook(
        "test-diff",
        { command: "git commit -m 'x'", cwd: dir, hook_event_name: "afterShellExecution" },
        dir,
      );
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
    const subDir = mkdtempSync(join(tmpdir(), "adg-agent-adapter-submodule-bump-"));
    runGit(subDir, ["init", "-q"]);
    runGit(subDir, ["config", "user.email", "test@example.invalid"]);
    runGit(subDir, ["config", "user.name", "Test"]);
    writeFileSync(join(subDir, "a.txt"), "hi\n");
    runGit(subDir, ["add", "a.txt"]);
    runGit(subDir, ["commit", "-q", "-m", "init"]);
    const subSha1 = spawnSync("git", ["rev-parse", "HEAD"], { cwd: subDir, encoding: "utf8" }).stdout.trim();
    writeFileSync(join(subDir, "a.txt"), "hi again\n");
    runGit(subDir, ["add", "a.txt"]);
    runGit(subDir, ["commit", "-q", "-m", "second"]);
    const subSha2 = spawnSync("git", ["rev-parse", "HEAD"], { cwd: subDir, encoding: "utf8" }).stdout.trim();

    try {
      mkdirSync(join(dir, "tests"), { recursive: true });
      runGit(dir, ["update-index", "--add", "--cacheinfo", `160000,${subSha1},tests/sub`]);
      runGit(dir, ["commit", "-q", "--no-verify", "-m", "add submodule"]);
      runGit(dir, ["update-index", "--add", "--cacheinfo", `160000,${subSha2},tests/sub`]);
      runGit(dir, ["commit", "-q", "--no-verify", "-m", "bump submodule"]);

      const result = runHook(
        "test-diff",
        { command: "git commit -m 'x'", cwd: dir, hook_event_name: "afterShellExecution" },
        dir,
      );
      assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /masked one at a time/);
      assert.match(result.stderr, /not blocking this commit/i);
    } finally {
      rmSync(subDir, { recursive: true, force: true });
    }
  });
});
