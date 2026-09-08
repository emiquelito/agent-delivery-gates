// Tests for the Claude Code plugin manifests. A plugin is how someone adopts
// these gates without editing their own settings file, so a typo in a path
// here means the hooks never run and nothing says so. That is the same silent
// pass the settings wiring tests exist to prevent, one layer out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface HookCommand {
  type: string;
  command?: string;
  args?: string[];
}
interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

function readJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8")) as T;
}

function pluginHooks(): Record<string, HookEntry[]> {
  return readJson<{ hooks: Record<string, HookEntry[]> }>("hooks/hooks.json").hooks;
}

function allCommands(): string[] {
  return Object.values(pluginHooks())
    .flat()
    .flatMap((entry) => entry.hooks.map((h) => h.command ?? ""));
}

test("the plugin manifest carries the fields the loader needs", () => {
  const manifest = readJson<Record<string, unknown>>(".claude-plugin/plugin.json");
  assert.equal(manifest.name, "agent-delivery-gates");
  assert.equal(typeof manifest.description, "string");
  assert.equal(typeof manifest.version, "string");
});

test("the marketplace lists this plugin and points at a real directory", () => {
  const market = readJson<{
    name: string;
    owner: { name: string };
    plugins: { name: string; source: string }[];
  }>(".claude-plugin/marketplace.json");
  assert.equal(typeof market.name, "string");
  assert.equal(typeof market.owner.name, "string");
  assert.ok(market.plugins.length > 0);
  for (const plugin of market.plugins) {
    assert.ok(plugin.source.startsWith("./"), `source must be a relative path: ${plugin.source}`);
    assert.ok(existsSync(join(ROOT, plugin.source)), `source does not exist: ${plugin.source}`);
    // A marketplace entry naming a plugin the repo does not define would
    // install nothing and say nothing.
    assert.ok(
      existsSync(join(ROOT, plugin.source, ".claude-plugin", "plugin.json")),
      `no plugin manifest under ${plugin.source}`,
    );
  }
});

test("every plugin hook command names a file that exists", () => {
  const commands = allCommands();
  assert.ok(commands.length > 0, "the plugin declares no hooks");
  for (const command of commands) {
    const match = /hooks\/([\w-]+\.ts)/.exec(command);
    assert.ok(match, `no hook path in command: ${command}`);
    assert.ok(existsSync(join(ROOT, "hooks", match[1])), `missing hook file: ${match[1]}`);
  }
});

// A path that resolves to nothing produces no error a person would see. The
// plugin root has to come from the variable the loader sets, never from a
// path relative to wherever the session happens to be.
test("every plugin hook command is anchored to the plugin root", () => {
  for (const command of allCommands()) {
    assert.match(command, /\$\{CLAUDE_PLUGIN_ROOT\}/);
    assert.match(command, /"\$\{CLAUDE_PLUGIN_ROOT\}/, "the variable must be quoted");
  }
});

test("every plugin hook command turns an unexpected failure into a block", () => {
  for (const command of allCommands()) {
    assert.match(command, /\|\|\s*exit 2\s*$/);
  }
});

test("the plugin guards every mutating tool and all four events", () => {
  const hooks = pluginHooks();
  assert.ok(hooks.PreToolUse, "no PreToolUse");
  assert.ok(hooks.PostToolUse, "no PostToolUse");
  assert.ok(hooks.Stop, "no Stop");
  const cleanTree = hooks.PreToolUse.find((e) =>
    e.hooks.some((h) => (h.command ?? "").includes("pre-mutation-clean-tree")),
  );
  assert.ok(cleanTree, "the clean tree gate is not on PreToolUse");
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.match(cleanTree.matcher ?? "", new RegExp(`\\b${tool}\\b`));
  }
});

// The plugin and the settings file wire the same gates. If one gains a hook
// and the other does not, a person gets different protection depending on
// which route they took, and nothing tells them.
test("the plugin and the settings file wire the same set of hooks", () => {
  const settings = readJson<{ hooks: Record<string, HookEntry[]> }>(".claude/settings.json").hooks;
  const names = (hooks: Record<string, HookEntry[]>): string[] =>
    Object.values(hooks)
      .flat()
      .flatMap((e) => e.hooks.map((h) => /hooks\/([\w-]+)\.ts/.exec(h.command ?? "")?.[1] ?? ""))
      .filter((n) => n !== "")
      .sort();
  assert.deepEqual(names(pluginHooks()), names(settings));
});
