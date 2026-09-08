// Tests for hooks/test-diff-post-tool-hook.ts. Every test spawns the hook
// as a real subprocess with JSON on stdin, the same way Claude Code invokes
// a PostToolUse hook, and asserts on exit code and stderr.
//
// Git fixtures live under a fresh directory in os.tmpdir() per test and are
// removed afterward. Nothing here ever touches this repository's own tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

function runHook(input: unknown, cwd?: string): RunResult {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  const result = spawnSync("node", [HOOK_PATH], { input: stdin, encoding: "utf8", cwd, env: process.env });
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

test("a non-Bash tool call: exits 0", () => {
  const result = runHook({ tool_name: "Write", tool_input: { file_path: "x" }, cwd: process.cwd() });
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
