// One mechanism decides whether a tool call is a mutation
// (isMutatingTool in src/clean-tree-gate.ts), and every path that needs
// that decision calls it: hooks/pre-mutation-clean-tree.ts directly, and
// src/agent-adapter.ts's runCleanTreeGate for the Cursor and Copilot
// adapters (hooks/cursor-hook.ts, hooks/copilot-hook.ts).
//
// Before this file existed, apply_patch sat in the Claude/Codex hook's own
// literal set but did not match the Cursor/Copilot adapter's separate
// EDIT_TOOL_PATTERN, so the identical tool call was guarded on one path and
// waved through on the other. This drives the same tool name, on a dirty
// tree, through all three entry points and asserts they land on the same
// verdict for every name, apply_patch included.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const CLAUDE_HOOK = join(REPO_ROOT, "hooks", "pre-mutation-clean-tree.ts");
const CURSOR_HOOK = join(REPO_ROOT, "hooks", "cursor-hook.ts");
const COPILOT_HOOK = join(REPO_ROOT, "hooks", "copilot-hook.ts");

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "adg-tool-agreement-test-"));
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  runGit(dir, ["add", "a.txt"]);
  runGit(dir, ["commit", "-q", "-m", "add a.txt"]);
  return dir;
}

function withDirtyTempRepo(fn: (dir: string) => void): void {
  const dir = makeTempRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "changed\n");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function baseEnv(dir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ADG_MUTATING_TOOLS;
  env.ADG_PHASE = "review";
  return env;
}

/** Whether the Claude/Codex hook (pre-mutation-clean-tree.ts) blocks this
 * tool name on a dirty tree. true means blocked (exit 2). */
function claudeBlocks(dir: string, toolName: string): boolean {
  const result = spawnSync("node", [CLAUDE_HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: {}, cwd: dir }),
    encoding: "utf8",
    env: baseEnv(dir),
  });
  return result.status === 2;
}

/** Whether the Cursor adapter path (clean-tree gate) blocks this tool name
 * on a dirty tree. Cursor denies either via exit 2 or via a deny body on
 * stdout with exit 0, so both are read here, not just the exit code. */
function cursorBlocks(dir: string, toolName: string): boolean {
  const result = spawnSync("node", [CURSOR_HOOK, "clean-tree"], {
    input: JSON.stringify({ tool_name: toolName, cwd: dir }),
    encoding: "utf8",
    env: baseEnv(dir),
  });
  if (result.status === 2) return true;
  if (result.status === 0 && result.stdout.trim() !== "") {
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    return body.permission === "deny";
  }
  return false;
}

/** Whether the Copilot adapter path (clean-tree gate) blocks this tool
 * name on a dirty tree. Copilot always writes its verdict as JSON on
 * stdout with exit 0. */
function copilotBlocks(dir: string, toolName: string): boolean {
  const result = spawnSync("node", [COPILOT_HOOK, "clean-tree"], {
    input: JSON.stringify({ toolName, cwd: dir }),
    encoding: "utf8",
    env: baseEnv(dir),
  });
  const body = JSON.parse(result.stdout) as Record<string, unknown>;
  return body.permissionDecision === "deny";
}

// apply_patch is the name the Claude/Codex hook and the Cursor/Copilot
// adapters disagreed on before this fix: verified for Codex, present in
// the old literal set, but not matched by the old EDIT_TOOL_PATTERN. The
// other four names span a Claude Code name, a second verified Codex name
// that matches no heuristic word, a name only the heuristic pattern
// reaches, and a plain read that should stay unguarded everywhere.
const TOOL_NAMES = ["apply_patch", "Edit", "unified_exec", "str_replace_editor", "read_file"];

for (const toolName of TOOL_NAMES) {
  test(`tool name '${toolName}' gets the same verdict on the Claude/Codex hook, Cursor, and Copilot paths`, () => {
    withDirtyTempRepo((dir) => {
      const claude = claudeBlocks(dir, toolName);
      const cursor = cursorBlocks(dir, toolName);
      const copilot = copilotBlocks(dir, toolName);
      assert.equal(
        cursor,
        claude,
        `Cursor (${cursor}) disagreed with the Claude/Codex hook (${claude}) for '${toolName}'`,
      );
      assert.equal(
        copilot,
        claude,
        `Copilot (${copilot}) disagreed with the Claude/Codex hook (${claude}) for '${toolName}'`,
      );
    });
  });
}
