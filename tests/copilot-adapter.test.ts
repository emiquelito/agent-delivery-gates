// Tests for hooks/copilot-hook.ts, templates/copilot-hooks.json, and the
// shared core in src/agent-adapter.ts, proven the same way
// tests/cursor-adapter.test.ts proves the Cursor adapter: spawning the
// real process on stdin/stdout/exit code, never calling an internal
// function directly.
//
// The contract table below is the point of this file: one row per
// platform, giving its own payload form and its own denial form, so a
// platform added later has one place to add a row instead of a place to
// forget. Every "blocked" and "allowed" case below runs once per row.
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
const CURSOR_HOOK = join(REPO_ROOT, "hooks", "cursor-hook.ts");
const COPILOT_HOOK = join(REPO_ROOT, "hooks", "copilot-hook.ts");
const BIN = join(REPO_ROOT, "bin", "adg.ts");

type GateName = "clean-tree" | "path-confinement" | "test-diff" | "report";
const GATES: GateName[] = ["clean-tree", "path-confinement", "test-diff", "report"];

interface CanonicalFields {
  toolName?: string;
  cwd?: string;
  filePath?: string;
  command?: string;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHook(hookPath: string, gate: string, input: unknown, env?: Record<string, string | undefined>): RunResult {
  const stdin = JSON.stringify(input);
  const fullEnv: Record<string, string | undefined> = { ...process.env };
  delete fullEnv.ADG_PHASE;
  delete fullEnv.ADG_ALLOWED_ROOTS;
  delete fullEnv.ADG_REPORT;
  delete fullEnv.ADG_PRIOR_FINDINGS;
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) delete fullEnv[key];
    else fullEnv[key] = value;
  }
  const result = spawnSync("node", [hookPath, gate], { input: stdin, encoding: "utf8", env: fullEnv });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runRawHook(hookPath: string, gate: string, rawInput: string): RunResult {
  const result = spawnSync("node", [hookPath, gate], { input: rawInput, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-copilot-adapter-test-"));
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
  const dir = mkdtempSync(join(tmpdir(), "adg-copilot-adapter-dir-"));
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

// --- the platform table ------------------------------------------------------
//
// One row per platform: its hook entry point, how it renders a
// CanonicalFields into that platform's own payload form, and how to
// recognise its own denial and its own allow. A platform added later needs
// one more row here, not a parallel set of tests.

interface PlatformRow {
  name: string;
  hookPath: string;
  payload(fields: CanonicalFields): unknown;
  assertDenied(result: RunResult): void;
  assertAllowed(result: RunResult): void;
}

/** Cursor denies by exiting 2, or by exit 0 with {permission:"deny", ...}
 * on stdout. Never exits 1: that is the one code that fails open. */
function assertCursorDenied(result: RunResult): void {
  assert.notEqual(result.status, 1, `must never exit 1 (fails open): stderr=${result.stderr}`);
  assert.ok(result.status === 0 || result.status === 2, `expected 0 or 2, got ${result.status}`);
  if (result.status === 0) {
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(body.permission, "deny");
    assert.equal(typeof body.agent_message, "string");
    assert.ok((body.agent_message as string).length > 0);
  }
}

function assertCursorAllowed(result: RunResult): void {
  assert.equal(result.status, 0, `expected allow (exit 0): stderr=${result.stderr}`);
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

/** Copilot denies by exit 0 with {permissionDecision:"deny",
 * permissionDecisionReason, ...} on stdout - see hooks/copilot-hook.ts for
 * why this file never relies on the exit code alone to signal a deny.
 * Never exits 1 either. */
function assertCopilotDenied(result: RunResult): void {
  assert.notEqual(result.status, 1, `must never exit 1 (fails open): stderr=${result.stderr}`);
  assert.equal(result.status, 0, `expected exit 0 with a deny body: stderr=${result.stderr}`);
  const body = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(body.permissionDecision, "deny");
  assert.equal(typeof body.permissionDecisionReason, "string");
  assert.ok((body.permissionDecisionReason as string).length > 0);
}

function assertCopilotAllowed(result: RunResult): void {
  assert.equal(result.status, 0, `expected allow (exit 0): stderr=${result.stderr}`);
  const trimmed = result.stdout.trim();
  if (trimmed !== "") {
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    assert.notEqual(body.permissionDecision, "deny");
  }
}

function cursorPayload(fields: CanonicalFields): unknown {
  const body: Record<string, unknown> = {};
  if (fields.toolName !== undefined) body.tool_name = fields.toolName;
  if (fields.cwd !== undefined) body.cwd = fields.cwd;
  if (fields.filePath !== undefined) body.file_path = fields.filePath;
  if (fields.command !== undefined) body.command = fields.command;
  return body;
}

/** Copilot's own field names, verified from GitHub's documentation:
 * toolName and cwd sit at the top level; there is no tool_name and no
 * tool_input. filePath and command are not documented at the top level at
 * all, so they travel inside toolArgs, the way an actual tool call's
 * arguments would. */
function copilotPayload(fields: CanonicalFields): unknown {
  const body: Record<string, unknown> = {};
  if (fields.toolName !== undefined) body.toolName = fields.toolName;
  if (fields.cwd !== undefined) body.cwd = fields.cwd;
  const toolArgs: Record<string, unknown> = {};
  if (fields.filePath !== undefined) toolArgs.file_path = fields.filePath;
  if (fields.command !== undefined) toolArgs.command = fields.command;
  if (Object.keys(toolArgs).length > 0) body.toolArgs = toolArgs;
  return body;
}

const PLATFORMS: PlatformRow[] = [
  {
    name: "cursor",
    hookPath: CURSOR_HOOK,
    payload: cursorPayload,
    assertDenied: assertCursorDenied,
    assertAllowed: assertCursorAllowed,
  },
  {
    name: "copilot",
    hookPath: COPILOT_HOOK,
    payload: copilotPayload,
    assertDenied: assertCopilotDenied,
    assertAllowed: assertCopilotAllowed,
  },
];

// --- one deny/allow scenario per gate, platform-independent -----------------
//
// Each scenario builds whatever fixture the gate needs (a temp git repo, a
// report file) and hands back CanonicalFields plus any env override; the
// platform table above turns those fields into that platform's own
// payload form.

interface Scenario {
  fields: CanonicalFields;
  env?: Record<string, string | undefined>;
}

function withCleanTreeDeny(fn: (s: Scenario) => void): void {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "a.txt"), "changed\n");
    fn({ fields: { toolName: "edit_file", cwd: dir }, env: { ADG_PHASE: "review" } });
  });
}

function withCleanTreeAllow(fn: (s: Scenario) => void): void {
  withTempRepo((dir) => {
    fn({ fields: { toolName: "edit_file", cwd: dir }, env: { ADG_PHASE: "review" } });
  });
}

function withPathConfinementDeny(fn: (s: Scenario) => void): void {
  withTempRepo((dir) => {
    fn({ fields: { filePath: "/definitely-not-an-allowed-root/secret.txt", cwd: dir } });
  });
}

function withPathConfinementAllow(fn: (s: Scenario) => void): void {
  withTempRepo((dir) => {
    fn({ fields: { filePath: join(dir, "a.txt"), cwd: dir } });
  });
}

function withTestDiffDeny(fn: (s: Scenario) => void): void {
  withTempRepo((dir) => {
    commitFile(dir, "tests/widget.test.ts", "expect(sum(1, 2)).toBe(3);\n");
    writeFileSync(join(dir, "tests/widget.test.ts"), "\n");
    runGit(dir, ["add", "tests/widget.test.ts"]);
    runGit(dir, ["commit", "-q", "-m", "remove the assertion"]);
    fn({ fields: { command: "git commit -m 'x'", cwd: dir } });
  });
}

function withTestDiffAllow(fn: (s: Scenario) => void): void {
  withTempRepo((dir) => {
    fn({ fields: { command: "npm test", cwd: dir } });
  });
}

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

function withReportDeny(fn: (s: Scenario) => void): void {
  withTempDir((dir) => {
    const p = join(dir, "report.md");
    writeFileSync(p, FAILING_REPORT);
    fn({ fields: {}, env: { ADG_REPORT: p } });
  });
}

function withReportAllow(fn: (s: Scenario) => void): void {
  withTempDir((dir) => {
    const p = join(dir, "report.md");
    writeFileSync(p, PASSING_REPORT);
    fn({ fields: {}, env: { ADG_REPORT: p } });
  });
}

const GATE_SCENARIOS: Record<GateName, { withDeny: (fn: (s: Scenario) => void) => void; withAllow: (fn: (s: Scenario) => void) => void }> = {
  "clean-tree": { withDeny: withCleanTreeDeny, withAllow: withCleanTreeAllow },
  "path-confinement": { withDeny: withPathConfinementDeny, withAllow: withPathConfinementAllow },
  "test-diff": { withDeny: withTestDiffDeny, withAllow: withTestDiffAllow },
  report: { withDeny: withReportDeny, withAllow: withReportAllow },
};

for (const gate of GATES) {
  const scenarios = GATE_SCENARIOS[gate];
  for (const platform of PLATFORMS) {
    test(`${platform.name}/${gate}: a payload that must be blocked produces ${platform.name}'s own denial`, () => {
      scenarios.withDeny((s) => {
        const result = runHook(platform.hookPath, gate, platform.payload(s.fields), s.env);
        platform.assertDenied(result);
      });
    });

    test(`${platform.name}/${gate}: a payload that must be allowed produces no denial, exit 0`, () => {
      scenarios.withAllow((s) => {
        const result = runHook(platform.hookPath, gate, platform.payload(s.fields), s.env);
        platform.assertAllowed(result);
      });
    });
  }
}

// --- the field-name test: a Copilot camelCase payload actually reaches the gate --
//
// This is the test that would have caught reading tool_name/cwd (Cursor's
// and this project's own spellings) instead of Copilot's toolName/cwd: a
// reader with the wrong keys sees undefined for everything, and clean-tree
// with an undefined toolName still runs (see EDIT_TOOL_PATTERN's comment in
// src/agent-adapter.ts), but an undefined cwd would fall back to this
// process's own working directory - this repository's checkout, which is
// clean - and wrongly allow.

// A dirty tree with toolName unread (undefined) still denies - see
// EDIT_TOOL_PATTERN's comment in src/agent-adapter.ts, an unrecognised
// tool errs toward checking. So the deny case above cannot, on its own,
// prove toolName was actually read: a reader that silently drops it would
// still pass it. This is the test that catches that: a non-mutating
// toolName ("Read") must allow even a dirty tree, and only does if the
// platform's reader actually read the field and matched it against
// EDIT_TOOL_PATTERN.
for (const platform of PLATFORMS) {
  test(`${platform.name}/clean-tree: a non-mutating toolName is allowed even with a dirty tree`, () => {
    withTempRepo((dir) => {
      writeFileSync(join(dir, "a.txt"), "changed\n");
      const result = runHook(
        platform.hookPath,
        "clean-tree",
        platform.payload({ toolName: "Read", cwd: dir }),
        { ADG_PHASE: "review" },
      );
      platform.assertAllowed(result);
    });
  });
}

test("copilot: a camelCase clean-tree payload (toolName, cwd) with a dirty tree denies", () => {
  withTempRepo((dir) => {
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const result = runHook(
      COPILOT_HOOK,
      "clean-tree",
      { toolName: "edit_file", cwd: dir },
      { ADG_PHASE: "review" },
    );
    assertCopilotDenied(result);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.match(body.permissionDecisionReason as string, /uncommitted changes/);
  });
});

// --- malformed input, every gate, both platforms: never exit 1 --------------

for (const platform of PLATFORMS) {
  for (const gate of GATES) {
    test(`${platform.name}/${gate}: malformed JSON on stdin never exits 1`, () => {
      const result = runRawHook(platform.hookPath, gate, "{not json");
      assert.notEqual(result.status, 1);
    });

    test(`${platform.name}/${gate}: empty stdin never exits 1`, () => {
      const result = runRawHook(platform.hookPath, gate, "");
      assert.notEqual(result.status, 1);
    });

    test(`${platform.name}/${gate}: a bare number on stdin never exits 1`, () => {
      const result = runRawHook(platform.hookPath, gate, "42");
      assert.notEqual(result.status, 1);
    });

    test(`${platform.name}/${gate}: literal null on stdin never exits 1`, () => {
      const result = runRawHook(platform.hookPath, gate, "null");
      assert.notEqual(result.status, 1);
    });

    test(`${platform.name}/${gate}: an array on stdin never exits 1`, () => {
      const result = runRawHook(platform.hookPath, gate, "[1,2,3]");
      assert.notEqual(result.status, 1);
    });
  }
}

test("copilot: an unknown gate name never exits 1", () => {
  const result = runRawHook(COPILOT_HOOK, "not-a-real-gate", "{}");
  assert.notEqual(result.status, 1);
});

// --- templates/copilot-hooks.json -------------------------------------------

test("templates/copilot-hooks.json parses, has version 1, names only real subcommands, and covers all four gates", () => {
  const raw = readFileSync(join(REPO_ROOT, "templates", "copilot-hooks.json"), "utf8");
  const parsed = JSON.parse(raw) as {
    version: number;
    hooks: Record<string, Array<{ command: string; type: string }>>;
  };
  assert.equal(parsed.version, 1);

  const REAL_SUBCOMMANDS = [
    "copilot-hook clean-tree",
    "copilot-hook path-confinement",
    "copilot-hook test-diff",
    "copilot-hook report",
  ];
  const seenGates = new Set<string>();
  const allEntries = Object.values(parsed.hooks).flat();
  assert.ok(allEntries.length >= 4);
  for (const entry of allEntries) {
    assert.equal(entry.type, "command");
    const match = REAL_SUBCOMMANDS.find((sub) => entry.command.includes(sub));
    assert.ok(match, `command does not name a real subcommand: ${entry.command}`);
    seenGates.add(match);
  }
  assert.deepEqual([...seenGates].sort(), [...REAL_SUBCOMMANDS].sort());

  // Every event this file wires up is one of the two spellings Copilot
  // accepts for the events these gates need.
  const KNOWN_EVENTS = new Set(["preToolUse", "PreToolUse", "postToolUse", "PostToolUse", "agentStop", "Stop"]);
  for (const event of Object.keys(parsed.hooks)) {
    assert.ok(KNOWN_EVENTS.has(event), `unexpected event name: ${event}`);
  }
});

// --- init writes .github/hooks/agent-delivery-gates.json only when absent ---

function runInitCli(args: string[], cwd: string): RunResult {
  const r = spawnSync(process.execPath, [BIN, "init", ...args], { encoding: "utf8", cwd });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("init writes .github/hooks/agent-delivery-gates.json when it does not exist", () => {
  withTempDir((dir) => {
    const r = runInitCli([], dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const target = join(dir, ".github", "hooks", "agent-delivery-gates.json");
    assert.ok(existsSync(target));
    const written = JSON.parse(readFileSync(target, "utf8")) as { version: number; hooks: Record<string, unknown> };
    assert.equal(written.version, 1);
    assert.ok(written.hooks.preToolUse);
    assert.match(r.stdout, /created: \.github[/\\]hooks[/\\]agent-delivery-gates\.json/);
  });
});

test("init leaves an existing .github/hooks/agent-delivery-gates.json untouched and prints it instead", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, ".github", "hooks"), { recursive: true });
    const target = join(dir, ".github", "hooks", "agent-delivery-gates.json");
    const existingContent = JSON.stringify({ version: 1, hooks: { custom: [{ command: "keep-me" }] } });
    writeFileSync(target, existingContent);

    const r = runInitCli([], dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);

    const stillThere = readFileSync(target, "utf8");
    assert.equal(stillThere, existingContent, "init must not edit an existing .github/hooks/agent-delivery-gates.json");

    assert.match(r.stdout, /exists, not written: \.github[/\\]hooks[/\\]agent-delivery-gates\.json/);
    assert.match(r.stdout, /does not edit an existing/);
    assert.match(r.stdout, /copilot-hook clean-tree/);
  });
});

test("--force: still leaves an existing .github/hooks/agent-delivery-gates.json unchanged", () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, ".github", "hooks"), { recursive: true });
    const target = join(dir, ".github", "hooks", "agent-delivery-gates.json");
    const existingContent = JSON.stringify({ version: 1, hooks: { custom: [{ command: "keep-me" }] } });
    writeFileSync(target, existingContent);

    const r = runInitCli(["--force"], dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(target, "utf8"), existingContent);
  });
});
