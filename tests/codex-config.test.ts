// Tests for templates/codex-hooks.json: the Codex CLI hook wiring for these
// gates. Codex needs configuration, not a translation layer, so unlike
// tests/cursor-adapter.test.ts, this file has no adapter of its own to spawn
// and no separate hook-contract to prove. What it checks is the template
// itself (parses, names only real subcommands, covers all four gates, and
// blocks on any operational failure) plus the two hook files the template
// wires in: they have to fire on a payload built like Codex's, whose tool
// name is not one of Claude Code's, since that is the entire point of this task.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TEMPLATE_PATH = join(ROOT, "templates", "codex-hooks.json");
const CLEAN_TREE_HOOK = join(ROOT, "hooks", "pre-mutation-clean-tree.ts");
const TEST_DIFF_HOOK = join(ROOT, "hooks", "test-diff-post-tool-hook.ts");

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

function readTemplate(): { hooks: Record<string, HookEntry[]> } {
  return JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as { hooks: Record<string, HookEntry[]> };
}

function allCommands(config: { hooks: Record<string, HookEntry[]> }): string[] {
  return Object.values(config.hooks)
    .flat()
    .flatMap((entry) => entry.hooks.map((h) => h.command));
}

// The exact subcommands bin/adg.ts actually implements. A template naming
// anything else would load, match, and fail silently at every invocation.
const REAL_SUBCOMMANDS = ["hook-clean-tree", "hook-path-confinement", "hook-test-diff", "hook-report"];

test("templates/codex-hooks.json parses as JSON", () => {
  assert.doesNotThrow(() => readTemplate());
});

test("covers all four gates: PreToolUse (clean-tree, path-confinement), PostToolUse (commit), Stop (report)", () => {
  const config = readTemplate();
  const commands = allCommands(config).join("\n");
  assert.match(commands, /hook-clean-tree/);
  assert.match(commands, /hook-path-confinement/);
  assert.match(commands, /hook-test-diff/);
  assert.match(commands, /hook-report/);
  assert.ok(Array.isArray(config.hooks.PreToolUse) && config.hooks.PreToolUse.length >= 2);
  assert.ok(Array.isArray(config.hooks.PostToolUse) && config.hooks.PostToolUse.length >= 1);
  assert.ok(Array.isArray(config.hooks.Stop) && config.hooks.Stop.length >= 1);
});

test("names only real subcommands", () => {
  const config = readTemplate();
  for (const command of allCommands(config)) {
    const named = REAL_SUBCOMMANDS.some((sub) => command.includes(sub));
    assert.ok(named, `command '${command}' does not name a real hook-* subcommand`);
  }
});

test("every command ends '|| exit 2'", () => {
  const config = readTemplate();
  for (const command of allCommands(config)) {
    assert.match(command.trim(), /\|\|\s*exit 2$/, `command '${command}' does not end with || exit 2`);
  }
});

test("every inner hook entry is a command type carrying a timeout", () => {
  const config = readTemplate();
  for (const entry of Object.values(config.hooks).flat()) {
    for (const hook of entry.hooks) {
      assert.equal(hook.type, "command");
      assert.equal(typeof hook.timeout, "number");
    }
  }
});

// --- the contract test: a gate fires on a payload built like Codex's -------
//
// tool names are not Claude Code's. Every hook the template wires up has to
// see this, or the whole task fails silently: a hook wired to more than one
// agent's tool names, loading, matching nothing, and exiting 0 with no sign
// anything was wrong is exactly the failure mode this task exists to close.

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function makeTempRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);
  return dir;
}

function withTempRepo(prefix: string, fn: (dir: string) => void): void {
  const dir = makeTempRepo(prefix);
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

test("PreToolUse clean-tree hook blocks a payload built like Codex's on a dirty tree", () => {
  withTempRepo("adg-codex-clean-tree-", (dir) => {
    commitFile(dir, "a.txt", "hello\n");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const env = { ...process.env, ADG_PHASE: "review" };
    const result = spawnSync("node", [CLEAN_TREE_HOOK], {
      input: JSON.stringify({ tool_name: "apply_patch", tool_input: {}, cwd: dir }),
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /a\.txt/);
  });
});

test("PostToolUse commit hook fires on a payload built like Codex's running git commit", () => {
  withTempRepo("adg-codex-commit-", (dir) => {
    commitFile(dir, "tests/widget.test.ts", "expect(sum(1, 2)).toBe(3);\n");
    writeFileSync(join(dir, "tests/widget.test.ts"), "\n");
    runGit(dir, ["add", "tests/widget.test.ts"]);
    runGit(dir, ["commit", "-q", "-m", "remove the assertion"]);
    const result = spawnSync("node", [TEST_DIFF_HOOK], {
      input: JSON.stringify({ tool_name: "shell", tool_input: { command: "git commit -m 'x'" }, cwd: dir }),
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /assertion-removed/);
  });
});
