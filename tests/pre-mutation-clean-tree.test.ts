// Tests for hooks/pre-mutation-clean-tree.ts. Every test spawns the hook as
// a real subprocess with JSON on stdin, the same way Claude Code invokes a
// PreToolUse hook, and asserts on exit code and stderr, never on an
// internal function's return value.
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
const HOOK_PATH = join(HERE, "..", "hooks", "pre-mutation-clean-tree.ts");

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
  delete env.ADG_PHASE;
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

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-clean-tree-test-"));
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);
  return dir;
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
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
  writeFileSync(join(dir, name), content);
  runGit(dir, ["add", name]);
  runGit(dir, ["commit", "-q", "-m", `add ${name}`]);
}

// A clean tree in review phase with tool Write: exit 0.
test("clean tree, review phase, Write: allowed", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    const result = runHook({
      input: { tool_name: "Write", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: "review" },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

// A dirty tree from a modified tracked file, review phase, tool Write:
// exit 2, stderr names that file.
test("dirty tree from modified tracked file, review phase: blocked and named", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const result = runHook({
      input: { tool_name: "Write", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: "review" },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /a\.txt/);
  });
});

// A dirty tree from an untracked file: exit 2, stderr names that file.
test("dirty tree from untracked file: blocked and named", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    writeFileSync(join(dir, "new-file.txt"), "surprise\n");
    const result = runHook({
      input: { tool_name: "Write", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: "review" },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /new-file\.txt/);
  });
});

// A dirty tree in mutation-testing phase: exit 2.
test("dirty tree, mutation-testing phase: blocked", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const result = runHook({
      input: { tool_name: "Edit", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: "mutation-testing" },
    });
    assert.equal(result.status, 2);
  });
});

// A dirty tree in build phase: exit 0, hook is not active in that phase.
test("dirty tree, build phase: allowed", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const result = runHook({
      input: { tool_name: "Edit", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: "build" },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

// A dirty tree with no phase set at all: exit 0.
test("dirty tree, no phase set: allowed", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const result = runHook({
      input: { tool_name: "Edit", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: undefined },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

// Tool Read with a dirty tree in review phase: exit 0, the hook only guards
// mutations.
test("non-mutating tool, dirty tree, review phase: allowed", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const result = runHook({
      input: { tool_name: "Read", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: "review" },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

// Empty stdin: exit 2.
test("empty stdin: blocked", () => {
  const result = runHook({ input: "", env: { ADG_PHASE: "review" } });
  assert.equal(result.status, 2);
});

// Malformed JSON on stdin: exit 2.
test("malformed JSON stdin: blocked", () => {
  const result = runHook({ input: "{not json", env: { ADG_PHASE: "review" } });
  assert.equal(result.status, 2);
});

// Valid JSON missing tool_name: exit 2.
test("JSON missing tool_name: blocked", () => {
  const result = runHook({ input: { tool_input: {} }, env: { ADG_PHASE: "review" } });
  assert.equal(result.status, 2);
});

// An unrecognised ADG_PHASE value: exit 2, stderr names the bad value.
test("unrecognised phase value: blocked and named", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    const result = runHook({
      input: { tool_name: "Write", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: "bogus-phase" },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /bogus-phase/);
  });
});

// Not a git repository, in review phase: exit 2.
test("not a git repository, review phase: blocked", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-clean-tree-nongit-"));
  try {
    const result = runHook({
      input: { tool_name: "Write", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: "review" },
    });
    assert.equal(result.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A dirty path containing a space: exit 2, stderr shows the full path intact.
test("dirty path containing a space: blocked and shown intact", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    writeFileSync(join(dir, "file with space.txt"), "surprise\n");
    const result = runHook({
      input: { tool_name: "Write", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: "review" },
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /file with space\.txt/);
  });
});

// More than 20 dirty paths: exit 2, stderr lists 20 and states how many more.
test("more than 20 dirty paths: lists 20 and states the remainder", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(dir, `untracked-${i}.txt`), "x\n");
    }
    const result = runHook({
      input: { tool_name: "Write", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: "review" },
    });
    assert.equal(result.status, 2);
    const listedCount = (result.stderr.match(/untracked-\d+\.txt/g) ?? []).length;
    assert.equal(listedCount, 20);
    assert.match(result.stderr, /5 more/);
  });
});

// The phase read from .claude/adg-phase when ADG_PHASE is unset: dirty tree
// gives exit 2.
test("phase from .claude/adg-phase file: dirty tree blocked", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "adg-phase"), "review\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const result = runHook({
      input: { tool_name: "Write", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: undefined },
    });
    assert.equal(result.status, 2);
  });
});

// ADG_PHASE takes precedence over the file when both are set and disagree.
test("ADG_PHASE overrides .claude/adg-phase file", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    // File says review (would block), env says build (allows).
    writeFileSync(join(dir, ".claude", "adg-phase"), "review\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const result = runHook({
      input: { tool_name: "Write", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: "build" },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});

// The four mutating tools must all be guarded. Dropping two of them from the
// guarded set used to pass every test, so each one is named here.
for (const tool of ["MultiEdit", "NotebookEdit"]) {
  test(`dirty tree, tool ${tool}, review phase: blocked`, () => {
    withTempRepo((dir) => {
      commitFile(dir, "a.txt", "hello\n");
      writeFileSync(join(dir, "a.txt"), "changed\n");
      const result = runHook({
        input: { tool_name: tool, tool_input: {}, cwd: dir },
        env: { ADG_PHASE: "review" },
      });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /a\.txt/);
    });
  });
}

// Both guarded phases need the allow case as well as the block case, or a
// hook that blocks unconditionally in one of them passes every test.
test("clean tree, mutation-testing phase: allowed", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    const result = runHook({
      input: { tool_name: "Write", tool_input: {}, cwd: dir },
      env: { ADG_PHASE: "mutation-testing" },
    });
    assert.equal(result.status, 0);
  });
});

// A phase file that exists but cannot be read must block. Reading it used to
// throw, which exited 1, and a non-zero code that is not 2 lets the tool run.
test("unreadable phase file: blocked, not a crash", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const phaseFile = join(dir, ".claude", "adg-phase");
    writeFileSync(phaseFile, "review\n");
    chmodSync(phaseFile, 0o000);
    try {
      const result = runHook({
        input: { tool_name: "Write", tool_input: {}, cwd: dir },
        env: { ADG_PHASE: undefined },
      });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /adg-phase/);
    } finally {
      chmodSync(phaseFile, 0o644);
    }
  });
});

// An inherited GIT_WORK_TREE used to point git at a different tree, so a
// dirty repository came back clean and the mutation was allowed.
test("inherited GIT_WORK_TREE does not hide a dirty tree", () => {
  withTempRepo((dirty) => {
    withTempRepo((clean) => {
      commitFile(clean, "a.txt", "hello\n");
      commitFile(dirty, "a.txt", "hello\n");
      writeFileSync(join(dirty, "a.txt"), "changed\n");
      for (const varName of ["GIT_WORK_TREE", "GIT_DIR"]) {
        const value = varName === "GIT_WORK_TREE" ? clean : join(clean, ".git");
        const result = runHook({
          input: { tool_name: "Write", tool_input: {}, cwd: dirty },
          env: { ADG_PHASE: "review", [varName]: value },
        });
        assert.equal(result.status, 2, `${varName} bypassed the gate`);
        assert.match(result.stderr, /a\.txt/);
      }
    });
  });
});

// A hook payload carries the whole file being written, which goes past the
// pipe buffer. Reading stdin in one call used to come back empty, which
// blocked every mutation including a clean tree in an unguarded phase.
test("payload larger than the pipe buffer is read in full", () => {
  withTempRepo((dir) => {
    commitFile(dir, "a.txt", "hello\n");
    const big = { tool_name: "Write", tool_input: { content: "x".repeat(300000) }, cwd: dir };
    const allowed = runHook({ input: big, env: { ADG_PHASE: "build" } });
    assert.equal(allowed.status, 0, "a large payload must not block on a clean tree");

    writeFileSync(join(dir, "a.txt"), "changed\n");
    const blocked = runHook({ input: big, env: { ADG_PHASE: "review" } });
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /a\.txt/);
  });
});
