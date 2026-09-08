// Tests for hooks/cursor-hook.ts and templates/cursor-hooks.json: the
// Cursor adapter for these gates. Written before the adapter worked, the
// same way every other hook-contract test in this repo drives the real
// process on stdin/stdout/exit code, never an internal function directly.
//
// The contract this file exists to prove: a gate that should block must
// produce a denial in CURSOR's terms, not this project's own exit-2/stderr
// contract. So every blocking case here asserts stdout parses as JSON with
// permission exactly "deny", and every case, blocking or not, asserts the
// exit code is never 1 - 1 is the one code that fails open in Cursor.
//
// Fixtures live under a fresh directory in os.tmpdir() per test and are
// removed afterward. Nothing here touches this repository's own tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const HOOK_PATH = join(REPO_ROOT, "hooks", "cursor-hook.ts");
const BIN = join(REPO_ROOT, "bin", "adg.ts");

interface RunOptions {
  gate: string;
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
  delete env.ADG_ALLOWED_ROOTS;
  delete env.ADG_REPORT;
  delete env.ADG_PRIOR_FINDINGS;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync("node", [HOOK_PATH, options.gate], {
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
  const dir = mkdtempSync(join(tmpdir(), "adg-cursor-adapter-test-"));
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

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-cursor-adapter-dir-"));
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

/** Asserts a run is a valid Cursor denial: exit 0 or 2, and, when 0, stdout
 * parses as JSON carrying permission "deny". Never 1: that is the one exit
 * code that fails open in Cursor's terms. */
function assertDenied(result: RunResult): void {
  assert.notEqual(result.status, 1, `must never exit 1 (fails open): stderr=${result.stderr}`);
  assert.ok(result.status === 0 || result.status === 2, `expected 0 or 2, got ${result.status}`);
  if (result.status === 0) {
    let body: unknown;
    try {
      body = JSON.parse(result.stdout);
    } catch (err) {
      assert.fail(`stdout was not JSON on a status-0 denial: ${result.stdout} (${(err as Error).message})`);
    }
    const obj = body as Record<string, unknown>;
    assert.equal(obj.permission, "deny");
    assert.equal(typeof obj.agent_message, "string");
    assert.ok((obj.agent_message as string).length > 0);
  }
}

/** Asserts a run is a valid Cursor allow: exit 0, no denial JSON on stdout. */
function assertAllowed(result: RunResult): void {
  assert.equal(result.status, 0, `expected allow (exit 0): stderr=${result.stderr}`);
  assert.notEqual(result.status, 1);
  const trimmed = result.stdout.trim();
  if (trimmed !== "") {
    let body: unknown;
    try {
      body = JSON.parse(trimmed);
    } catch {
      body = undefined;
    }
    if (body && typeof body === "object") {
      assert.notEqual((body as Record<string, unknown>).permission, "deny");
    }
  }
}

// --- clean-tree, on preToolUse ------------------------------------------------

test("clean-tree: a dirty tree in the review phase is denied", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const result = runHook({
      gate: "clean-tree",
      input: { tool_name: "edit_file", cwd: dir, hook_event_name: "preToolUse" },
      env: { ADG_PHASE: "review" },
    });
    assertDenied(result);
  });
});

test("clean-tree: a clean tree in the review phase is allowed", () => {
  withTempRepo((dir) => {
    const result = runHook({
      gate: "clean-tree",
      input: { tool_name: "edit_file", cwd: dir, hook_event_name: "preToolUse" },
      env: { ADG_PHASE: "review" },
    });
    assertAllowed(result);
  });
});

test("clean-tree: a dirty tree in the build phase is allowed regardless", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const result = runHook({
      gate: "clean-tree",
      input: { tool_name: "edit_file", cwd: dir, hook_event_name: "preToolUse" },
      env: { ADG_PHASE: "build" },
    });
    assertAllowed(result);
  });
});

// --- path-confinement, on beforeReadFile ---------------------------------------

test("path-confinement: a path outside every allowed root is denied", () => {
  withTempRepo((dir) => {
    const result = runHook({
      gate: "path-confinement",
      input: { file_path: "/definitely-not-an-allowed-root/secret.txt", hook_event_name: "beforeReadFile" },
      cwd: dir,
    });
    assertDenied(result);
  });
});

test("path-confinement: a path inside the repo is allowed", () => {
  withTempRepo((dir) => {
    const result = runHook({
      gate: "path-confinement",
      input: { file_path: join(dir, "a.txt"), hook_event_name: "beforeReadFile" },
      cwd: dir,
    });
    assertAllowed(result);
  });
});

// --- test-diff, on afterShellExecution ------------------------------------------

test("test-diff: a commit that weakens a test is denied", () => {
  withTempRepo((dir) => {
    commitFile(dir, "tests/widget.test.ts", "expect(sum(1, 2)).toBe(3);\n");
    writeFileSync(join(dir, "tests/widget.test.ts"), "\n");
    runGit(dir, ["add", "tests/widget.test.ts"]);
    runGit(dir, ["commit", "-q", "-m", "remove the assertion"]);
    const result = runHook({
      gate: "test-diff",
      input: { command: "git commit -m 'x'", cwd: dir, hook_event_name: "afterShellExecution" },
    });
    assertDenied(result);
    if (result.status === 0) {
      const body = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.match(body.agent_message as string, /assertion-removed/);
    } else {
      assert.match(result.stderr, /assertion-removed/);
    }
  });
});

test("test-diff: a commit with no weakening signal is allowed", () => {
  withTempRepo((dir) => {
    commitFile(dir, "src/widget.ts", "return a + b;\n");
    writeFileSync(join(dir, "src/widget.ts"), "return a - b;\n");
    runGit(dir, ["add", "src/widget.ts"]);
    runGit(dir, ["commit", "-q", "-m", "fix the sign"]);
    const result = runHook({
      gate: "test-diff",
      input: { command: "git commit -m 'x'", cwd: dir, hook_event_name: "afterShellExecution" },
    });
    assertAllowed(result);
  });
});

test("test-diff: a shell command that is not a commit is allowed", () => {
  withTempRepo((dir) => {
    const result = runHook({
      gate: "test-diff",
      input: { command: "npm test", cwd: dir, hook_event_name: "afterShellExecution" },
    });
    assertAllowed(result);
  });
});

// --- report, on stop --------------------------------------------------------

const PASSING_REPORT = [
  "# Report",
  "",
  "The dirty tree case is handled.",
  "Evidence: commit a1b2c3d4 and tests/report-validator.test.ts.",
  "",
  "## Findings",
  "",
  "- Low: wording",
  "",
  "Committed as a1b2c3d4; tree clean.",
  "",
].join("\n");

const FAILING_REPORT = ["# Report", "", "The dirty tree case is handled.", ""].join("\n");

test("report: a failing report named by ADG_REPORT is denied", () => {
  withTempDir((dir) => {
    const p = join(dir, "report.md");
    writeFileSync(p, FAILING_REPORT);
    const result = runHook({
      gate: "report",
      input: { status: "completed", loop_count: 1, hook_event_name: "stop" },
      env: { ADG_REPORT: p },
    });
    assertDenied(result);
  });
});

test("report: a passing report named by ADG_REPORT is allowed", () => {
  withTempDir((dir) => {
    const p = join(dir, "report.md");
    writeFileSync(p, PASSING_REPORT);
    const result = runHook({
      gate: "report",
      input: { status: "completed", loop_count: 1, hook_event_name: "stop" },
      env: { ADG_REPORT: p },
    });
    assertAllowed(result);
  });
});

test("report: no report named (Cursor's stop payload carries no path) is allowed", () => {
  const result = runHook({
    gate: "report",
    input: { status: "completed", loop_count: 1, hook_event_name: "stop" },
  });
  assertAllowed(result);
});

// --- malformed input, every gate: must exit 2, never 0 with an allow ------------

const GATES = ["clean-tree", "path-confinement", "test-diff", "report"];

for (const gate of GATES) {
  test(`${gate}: malformed JSON on stdin exits 2`, () => {
    const result = runHook({ gate, input: "{not json" });
    assert.equal(result.status, 2);
  });

  test(`${gate}: empty stdin exits 2`, () => {
    const result = runHook({ gate, input: "" });
    assert.equal(result.status, 2);
  });

  test(`${gate}: a payload that is not an object exits 2`, () => {
    const result = runHook({ gate, input: "42" });
    assert.equal(result.status, 2);
  });

  test(`${gate}: a payload of literal null exits 2, not on an uncaught error`, () => {
    const result = runHook({ gate, input: "null" });
    assert.equal(result.status, 2);
  });

  test(`${gate}: never exits 1`, () => {
    for (const input of ["{not json", "", "42", "null", JSON.stringify({})]) {
      const result = runHook({ gate, input });
      assert.notEqual(result.status, 1, `gate ${gate} input ${input} exited 1: ${result.stderr}`);
    }
  });
}

test("an unknown gate name exits 2", () => {
  const result = runHook({ gate: "not-a-real-gate", input: {} });
  assert.equal(result.status, 2);
});

// --- templates/cursor-hooks.json -------------------------------------------

test("templates/cursor-hooks.json parses, sets failClosed on every entry, and covers all four gates", () => {
  const raw = readFileSync(join(REPO_ROOT, "templates", "cursor-hooks.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    version: number;
    hooks: Record<string, Array<{ command: string; type: string; failClosed: boolean }>>;
  };
  assert.equal(parsed.version, 1);

  const REAL_SUBCOMMANDS = ["cursor-hook clean-tree", "cursor-hook path-confinement", "cursor-hook test-diff", "cursor-hook report"];
  const seenGates = new Set<string>();
  const allEntries = Object.values(parsed.hooks).flat();
  assert.ok(allEntries.length >= 4);
  for (const entry of allEntries) {
    assert.equal(entry.type, "command");
    assert.equal(entry.failClosed, true, `entry missing failClosed: ${entry.command}`);
    const match = REAL_SUBCOMMANDS.find((sub) => entry.command.includes(sub));
    assert.ok(match, `command does not name a real subcommand: ${entry.command}`);
    seenGates.add(match);
  }
  assert.deepEqual([...seenGates].sort(), [...REAL_SUBCOMMANDS].sort());

  // Every event this file wires up is one of the events the task names as
  // mattering for these gates.
  const KNOWN_EVENTS = new Set([
    "preToolUse",
    "postToolUse",
    "beforeShellExecution",
    "afterShellExecution",
    "beforeReadFile",
    "afterFileEdit",
    "stop",
  ]);
  for (const event of Object.keys(parsed.hooks)) {
    assert.ok(KNOWN_EVENTS.has(event), `unexpected event name: ${event}`);
  }
});

// --- init writes .cursor/hooks.json only when absent ----------------------

function runInitCli(args: string[], cwd: string): RunResult {
  const r = spawnSync(BIN, ["init", ...args], { encoding: "utf8", cwd });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("init writes .cursor/hooks.json when it does not exist", () => {
  withTempDir((dir) => {
    const r = runInitCli([], dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const target = join(dir, ".cursor", "hooks.json");
    assert.ok(existsSync(target));
    const written = JSON.parse(readFileSync(target, "utf8")) as { hooks: Record<string, unknown> };
    assert.ok(written.hooks.preToolUse);
    assert.match(r.stdout, /created: .cursor[/\\]hooks\.json/);
  });
});

test("init leaves an existing .cursor/hooks.json untouched and prints it instead", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, ".cursor"), { recursive: true });
    const existingContent = JSON.stringify({ version: 1, hooks: { custom: [{ command: "keep-me" }] } });
    writeFileSync(join(dir, ".cursor", "hooks.json"), existingContent);

    const r = runInitCli([], dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);

    const stillThere = readFileSync(join(dir, ".cursor", "hooks.json"), "utf8");
    assert.equal(stillThere, existingContent, "init must not edit an existing .cursor/hooks.json");

    assert.match(r.stdout, /exists, not written: \.cursor[/\\]hooks\.json/);
    assert.match(r.stdout, /does not edit an existing/);
    // The template's own content is printed so a person can merge it by hand.
    assert.match(r.stdout, /cursor-hook clean-tree/);
  });
});
