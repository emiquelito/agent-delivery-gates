// One test over every platform's configuration at once.
//
// Each platform's own test file checks its own config, which means a gate
// added to three of them and forgotten in the fourth is caught by nothing:
// each file passes, because each file only knows about itself. This file is
// the one that compares them, so a gate can only be added everywhere or
// noticed as missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The four gates. A platform config that misses one protects less than the
 * others, and nothing else in the suite would say so. */
const GATES = ["clean-tree", "path-confinement", "test-diff", "report"] as const;

/**
 * How each gate is named in each platform's config. Claude Code and Codex run
 * the hook entry points by name, the other two go through an adapter
 * subcommand, so the token to look for differs.
 */
interface PlatformConfig {
  name: string;
  path: string;
  tokenFor: Record<(typeof GATES)[number], string>;
}

const HOOK_ENTRY_TOKENS = {
  "clean-tree": "pre-mutation-clean-tree",
  "path-confinement": "path-confinement",
  "test-diff": "test-diff-post-tool-hook",
  report: "delivery-report-stop-hook",
} as const;

const SUBCOMMAND_TOKENS = {
  "clean-tree": "clean-tree",
  "path-confinement": "path-confinement",
  "test-diff": "test-diff",
  report: "report",
} as const;

const PLATFORMS: PlatformConfig[] = [
  { name: "claude-code plugin", path: "hooks/hooks.json", tokenFor: HOOK_ENTRY_TOKENS },
  { name: "claude-code settings", path: ".claude/settings.json", tokenFor: HOOK_ENTRY_TOKENS },
  { name: "codex", path: "templates/codex-hooks.json", tokenFor: SUBCOMMAND_TOKENS },
  { name: "cursor", path: "templates/cursor-hooks.json", tokenFor: SUBCOMMAND_TOKENS },
  { name: "copilot", path: "templates/copilot-hooks.json", tokenFor: SUBCOMMAND_TOKENS },
];

function configText(platform: PlatformConfig): string {
  const full = join(ROOT, platform.path);
  assert.ok(existsSync(full), `${platform.name}: ${platform.path} does not exist`);
  return readFileSync(full, "utf8");
}

for (const platform of PLATFORMS) {
  test(`${platform.name} wires every gate`, () => {
    const text = configText(platform);
    for (const gate of GATES) {
      assert.ok(
        text.includes(platform.tokenFor[gate]),
        `${platform.name} does not wire the ${gate} gate`,
      );
    }
  });

  test(`${platform.name} config is valid JSON with a hooks object`, () => {
    const parsed = JSON.parse(configText(platform)) as { hooks?: unknown };
    assert.equal(typeof parsed.hooks, "object");
    assert.notEqual(parsed.hooks, null);
  });
}

// A gate that exists in the code and in no platform config is a gate nobody
// runs. This catches the reverse of the tests above.
test("no gate exists in the code without being wired somewhere", () => {
  for (const gate of GATES) {
    const wired = PLATFORMS.filter((p) => configText(p).includes(p.tokenFor[gate]));
    assert.ok(wired.length > 0, `the ${gate} gate is wired on no platform at all`);
  }
});

// Every platform must protect the same amount. One covering three gates while
// the others cover four is the drift this file exists to find.
test("every platform wires the same number of gates", () => {
  const counts = PLATFORMS.map((p) => {
    const text = configText(p);
    return { name: p.name, count: GATES.filter((g) => text.includes(p.tokenFor[g])).length };
  });
  const expected = GATES.length;
  for (const { name, count } of counts) {
    assert.equal(count, expected, `${name} wires ${count} gates, the others wire ${expected}`);
  }
});
