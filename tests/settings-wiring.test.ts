// Tests for .claude/settings.json. The settings file is the only thing that
// turns three working hooks into an enforcement layer, and a typo in a path
// there fails silently: the hook never runs and every tool call looks fine.
// Nothing else in this repo would notice, so these tests check the wiring
// itself, not the hooks it points at.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SETTINGS_PATH = join(ROOT, ".claude", "settings.json");

interface HookCommand {
  type: string;
  command: string;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}
interface Settings {
  hooks: Record<string, HookEntry[]>;
}

function readSettings(): Settings {
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Settings;
}

function allCommands(settings: Settings): string[] {
  return Object.values(settings.hooks)
    .flat()
    .flatMap((entry) => entry.hooks.map((h) => h.command));
}

test("the settings file exists and parses", () => {
  assert.ok(existsSync(SETTINGS_PATH));
  assert.ok(readSettings().hooks);
});

// hooks/ holds command line tools as well as hook entry points, and those
// tools exit 1 on a failed report, a code no hook contract defines. Naming
// the entry points keeps a command line tool from being wired as a hook.
const HOOK_ENTRY_POINTS = new Set([
  "pre-mutation-clean-tree.ts",
  "path-confinement.ts",
  "test-diff-post-tool-hook.ts",
  "delivery-report-stop-hook.ts",
]);

test("every command names a hook entry point, not a command line tool", () => {
  for (const command of allCommands(readSettings())) {
    const match = /hooks\/([\w-]+\.ts)/.exec(command);
    assert.ok(match, `no hook path found in command: ${command}`);
    assert.ok(
      HOOK_ENTRY_POINTS.has(match[1]),
      `${match[1]} is not a hook entry point; hooks/ also holds command line tools`,
    );
  }
});

test("every hook file named in the settings exists on disk", () => {
  const commands = allCommands(readSettings());
  assert.ok(commands.length > 0);
  for (const command of commands) {
    const match = /hooks\/([\w-]+\.ts)/.exec(command);
    assert.ok(match, `no hook path found in command: ${command}`);
    const path = join(ROOT, "hooks", match[1]);
    assert.ok(existsSync(path), `settings names a hook that does not exist: ${match[1]}`);
  }
});

test("all three gates are wired, one per event", () => {
  const settings = readSettings();
  assert.ok(settings.hooks.PreToolUse, "no PreToolUse entry");
  assert.ok(settings.hooks.PostToolUse, "no PostToolUse entry");
  assert.ok(settings.hooks.Stop, "no Stop entry");
  const commands = allCommands(settings).join(" ");
  assert.match(commands, /pre-mutation-clean-tree\.ts/);
  assert.match(commands, /test-diff-post-tool-hook\.ts/);
  assert.match(commands, /delivery-report-stop-hook\.ts/);
});

// The clean-tree gate guards mutations, so its matcher has to name every tool
// that mutates. A tool missing here is a tool that edits an unclean tree with
// nothing watching.
test("the clean-tree matcher names every mutating tool", () => {
  const settings = readSettings();
  const entry = settings.hooks.PreToolUse.find((e) =>
    e.hooks.some((h) => h.command.includes("pre-mutation-clean-tree.ts")),
  );
  assert.ok(entry, "the clean-tree hook is not on PreToolUse");
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.match(entry.matcher ?? "", new RegExp(`\\b${tool}\\b`));
  }
});

// Every command has to resolve from any working directory, because a hook is
// run from wherever the session happens to be.
test("every hook command is anchored to the project directory", () => {
  for (const command of allCommands(readSettings())) {
    assert.match(command, /\$CLAUDE_PROJECT_DIR/);
  }
});

// The working default is written down here on purpose. Leaving it unset would
// mean the gate's state depends on what nobody typed, and the point of this
// file is that the enforcement layer is readable.
test("the working phase default is stated in the settings, not left implied", () => {
  const commands = allCommands(readSettings()).join(" ");
  // Which phase is the working default is a workflow choice. The invariant is
  // that it is written down here and can be read, instead of depending on
  // what nobody typed.
  assert.match(commands, /ADG_PHASE="\$\{ADG_PHASE:-[a-z-]+\}"/);
});

// If the project directory variable is missing, node cannot find the hook and
// exits 1. A hook contract has only 0 and 2 in it, and anything else is read
// as a non-blocking error, so the tool call would proceed unchecked. Every
// command turns an unexpected failure into a block.
test("every hook command turns an unexpected failure into a block", () => {
  for (const command of allCommands(readSettings())) {
    assert.match(command, /\|\|\s*exit 2\s*$/);
  }
});
