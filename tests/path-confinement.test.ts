// Tests for hooks/path-confinement.ts. Every test spawns the hook as a real
// subprocess with JSON on stdin, the same way Claude Code invokes a
// PreToolUse hook, and asserts on exit code and stderr, never on an internal
// function's return value.
//
// Fixtures live under a fresh directory in os.tmpdir() per test and are
// removed afterward. Nothing here ever creates a git repository inside this
// repository's own tree.
//
// The symlink-escapes-a-root case is covered at the core level in
// tests/path-allowlist.test.ts, with a fake resolver standing in for the
// filesystem. Reproducing it here would need a fixture actually outside
// every default root, but os.tmpdir() is always one of those roots, so a
// hook-level fixture cannot land outside all of them without a location
// above this repository, which is off limits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = join(HERE, "..", "hooks", "path-confinement.ts");

interface RunOptions {
  input: unknown | string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHook(options: RunOptions): RunResult {
  const stdin = typeof options.input === "string" ? options.input : JSON.stringify(options.input);
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ADG_ALLOWED_ROOTS;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  const result = spawnSync("node", [HOOK_PATH], {
    cwd: options.cwd,
    input: stdin,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-path-confinement-test-"));
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

const KEY_FOR: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

for (const tool of ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
  test(`${tool} for a path inside the repo: allowed`, () => {
    withTempRepo((dir) => {
      const result = runHook({
        input: { tool_name: tool, tool_input: { [KEY_FOR[tool]!]: join(dir, "a.txt") }, cwd: dir },
      });
      assert.equal(result.status, 0, result.stderr);
    });
  });

  // Neither the repo nor the system temp directory contains this path, and
  // no ADG_ALLOWED_ROOTS is set, so it must be denied regardless of whether
  // the path itself exists anywhere.
  test(`${tool} for a path outside every allowed root: blocked`, () => {
    withTempRepo((dir) => {
      const foreign = "/definitely-not-an-allowed-root/secret.txt";
      const result = runHook({
        input: { tool_name: tool, tool_input: { [KEY_FOR[tool]!]: foreign }, cwd: dir },
      });
      assert.equal(result.status, 2);
    });
  });
}

test("Bash exits 0 regardless of its command text", () => {
  withTempRepo((dir) => {
    const result = runHook({
      input: { tool_name: "Bash", tool_input: { command: "cat /etc/passwd" }, cwd: dir },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("an unknown tool exits 0", () => {
  withTempRepo((dir) => {
    const result = runHook({
      input: { tool_name: "SomeFutureTool", tool_input: {}, cwd: dir },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("a checked tool with no recognisable path exits 2", () => {
  withTempRepo((dir) => {
    const result = runHook({
      input: { tool_name: "Write", tool_input: { content: "x" }, cwd: dir },
    });
    assert.equal(result.status, 2);
  });
});

test("empty stdin exits 2", () => {
  const result = runHook({ input: "" });
  assert.equal(result.status, 2);
});

test("malformed JSON exits 2", () => {
  const result = runHook({ input: "{not json" });
  assert.equal(result.status, 2);
});

test("a payload of literal null exits 2", () => {
  const result = runHook({ input: "null" });
  assert.equal(result.status, 2);
});

test("ADG_ALLOWED_ROOTS adds a root that then allows a path under it", () => {
  withTempRepo((dir) => {
    const extraRoot = mkdtempSync(join(tmpdir(), "adg-path-confinement-extra-"));
    try {
      const target = join(extraRoot, "note.txt");
      writeFileSync(target, "x\n");
      const result = runHook({
        input: { tool_name: "Read", tool_input: { file_path: target }, cwd: dir },
        env: { ADG_ALLOWED_ROOTS: extraRoot },
      });
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(extraRoot, { recursive: true, force: true });
    }
  });
});

test("ADG_ALLOWED_ROOTS with several roots, delimiter separated, still allows the repo", () => {
  withTempRepo((dir) => {
    const extraRoot = mkdtempSync(join(tmpdir(), "adg-path-confinement-extra2-"));
    try {
      const result = runHook({
        input: { tool_name: "Read", tool_input: { file_path: join(dir, "a.txt") }, cwd: dir },
        env: { ADG_ALLOWED_ROOTS: `${extraRoot}${delimiter}/definitely-nowhere-real` },
      });
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(extraRoot, { recursive: true, force: true });
    }
  });
});

test("a directory that is not a repository exits 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-path-confinement-nongit-"));
  try {
    const result = runHook({
      input: { tool_name: "Read", tool_input: { file_path: join(dir, "a.txt") }, cwd: dir },
    });
    assert.equal(result.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
