// Finding 6 regression: src/agent-adapter.ts's runTestDiffGate called
// separateTestDiff directly, the one production entry point that read a
// diff without ever warming the Python language service first
// (hooks/test-diff-separator.ts, hooks/test-diff-post-tool-hook.ts, and
// src/mcp-server.ts each warm; this one did not). A Copilot or Cursor user
// committing a .py file got the regex mask with nothing to say a better
// one existed.
//
// This drives runTestDiffGate directly (not through a spawned hook
// process, since agent-adapter.ts is a pure function with no process.exit
// of its own) against a real git commit that removes a Python line whose
// code carries no assertion at all, only a trailing "#" comment that
// happens to contain the word "assert". The regex scanner does not know
// the "#" comment form (see src/code-mask.ts), so unwarmed it misreads
// that comment as a real assertion and denies a commit that changed
// nothing worth denying. Warmed first, through separateTestDiffWarmed, the
// tree-sitter service masks the comment away and the same commit is
// allowed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runTestDiffGate } from "../src/agent-adapter.ts";

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-agent-adapter-py-test-"));
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  runGit(dir, ["add", "a.txt"]);
  runGit(dir, ["commit", "-q", "-m", "add a.txt"]);
  return dir;
}

function commitFile(dir: string, name: string, content: string): void {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content);
  runGit(dir, ["add", name]);
  runGit(dir, ["commit", "-q", "-m", `write ${name}`]);
}

function withTempRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = makeTempRepo();
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

const PY_TEST_PATH = "tests/test_thing.py";
const BEFORE = ["def test_thing():", "    result = compute()  # assert result == 42", "    assert result == 41", ""].join(
  "\n",
);
const AFTER = ["def test_thing():", "    assert result == 41", ""].join("\n");

test("Finding 6: a Python commit whose only removed line is a trailing '#' comment is allowed, not falsely denied", async () => {
  await withTempRepo(async (dir) => {
    commitFile(dir, PY_TEST_PATH, BEFORE);
    writeFileSync(join(dir, PY_TEST_PATH), AFTER);
    runGit(dir, ["add", PY_TEST_PATH]);
    runGit(dir, ["commit", "-q", "-m", "drop the stale comment"]);

    const decision = await runTestDiffGate({ command: "git commit -m 'x'", cwd: dir });
    assert.equal(
      decision.kind,
      "allow",
      `expected allow, got ${decision.kind}: ${decision.kind === "deny" ? decision.agentMessage : decision.kind === "error" ? decision.message : ""}`,
    );
  });
});
