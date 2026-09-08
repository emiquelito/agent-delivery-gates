// Tests for src/test-diff-config.ts: parsing, merging, validating, and
// locating a rules config, apart from the CLI that reads it from disk (see
// tests/test-diff-separator-cli.test.ts for --config end to end).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  loadRuleSet,
  mergeRules,
  parseConfig,
  resolveConfigPath,
} from "../src/test-diff-config.ts";
import { DEFAULT_RULES } from "../src/test-diff-separator.ts";

// --- resolveConfigPath: first match wins --------------------------------------

test("resolveConfigPath prefers an explicit path over everything else", () => {
  const path = resolveConfigPath({
    explicitPath: "/explicit.json",
    env: { ADG_TEST_DIFF_CONFIG: "/env.json" },
    repoRoot: "/repo",
  });
  assert.equal(path, "/explicit.json");
});

test("resolveConfigPath falls back to the environment variable when no explicit path is given", () => {
  const path = resolveConfigPath({ env: { ADG_TEST_DIFF_CONFIG: "/env.json" }, repoRoot: "/repo" });
  assert.equal(path, "/env.json");
});

test("resolveConfigPath falls back to .adg/test-diff.json at the repo root when it exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-test-diff-config-test-"));
  try {
    const adgDir = join(dir, ".adg");
    mkdirSync(adgDir);
    writeFileSync(join(adgDir, "test-diff.json"), "{}");
    const path = resolveConfigPath({ env: {}, repoRoot: dir });
    assert.equal(path, join(dir, ".adg", "test-diff.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfigPath returns null when nothing applies: the built-in defaults alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "adg-test-diff-config-test-"));
  try {
    const path = resolveConfigPath({ env: {}, repoRoot: dir });
    assert.equal(path, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- parseConfig: document validation -----------------------------------------

test("parseConfig accepts an empty object: nothing to add or replace", () => {
  assert.deepEqual(parseConfig("{}"), {});
});

test("parseConfig reads add and replace for a replaceable bucket", () => {
  const parsed = parseConfig('{"testPaths": {"add": ["\\\\.feature$"], "replace": ["^only$"]}}');
  assert.deepEqual(parsed.testPaths, { add: ["\\.feature$"], replace: ["^only$"] });
});

test("parseConfig throws on malformed JSON", () => {
  assert.throws(() => parseConfig("{not json"), ConfigError);
});

test("parseConfig throws when the document is not a JSON object", () => {
  assert.throws(() => parseConfig("[1, 2, 3]"), ConfigError);
  assert.throws(() => parseConfig('"a string"'), ConfigError);
});

test("parseConfig throws on an unknown top-level key", () => {
  assert.throws(() => parseConfig('{"bogus": {"add": []}}'), ConfigError);
});

test("parseConfig throws on an unknown key inside a bucket", () => {
  assert.throws(() => parseConfig('{"testPaths": {"remove": []}}'), ConfigError);
});

test("parseConfig throws when replace is used on tolerance, a non-replaceable bucket", () => {
  assert.throws(() => parseConfig('{"tolerance": {"replace": ["\\\\bfudge\\\\b"]}}'), ConfigError);
});

test("parseConfig allows add on tolerance", () => {
  const parsed = parseConfig('{"tolerance": {"add": ["\\\\bfudge\\\\b"]}}');
  assert.deepEqual(parsed.tolerance, { add: ["\\bfudge\\b"] });
});

test("parseConfig throws when add is not an array of strings", () => {
  assert.throws(() => parseConfig('{"testPaths": {"add": "not-an-array"}}'), ConfigError);
  assert.throws(() => parseConfig('{"testPaths": {"add": [1, 2]}}'), ConfigError);
});

// --- mergeRules: add extends, replace discards --------------------------------

test("mergeRules with add appends to the base list, keeping the defaults", () => {
  const merged = mergeRules(DEFAULT_RULES, { skips: { add: ["\\bpaused\\("] } });
  assert.deepEqual(merged.skips, [...DEFAULT_RULES.skips, "\\bpaused\\("]);
  // Every other bucket is untouched.
  assert.deepEqual(merged.assertions, DEFAULT_RULES.assertions);
});

test("mergeRules with replace discards the base list entirely", () => {
  const merged = mergeRules(DEFAULT_RULES, { skips: { replace: ["\\bpaused\\("] } });
  assert.deepEqual(merged.skips, ["\\bpaused\\("]);
});

test("mergeRules with both replace and add starts from replace, then appends add", () => {
  const merged = mergeRules(DEFAULT_RULES, { skips: { replace: ["\\bpaused\\("], add: ["\\bstalled\\("] } });
  assert.deepEqual(merged.skips, ["\\bpaused\\(", "\\bstalled\\("]);
});

// --- loadRuleSet: end to end against a real file ------------------------------

function withConfigFile(content: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adg-test-diff-config-test-"));
  const path = join(dir, "test-diff.json");
  try {
    writeFileSync(path, content);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadRuleSet(null) returns the built-in defaults untouched", () => {
  assert.deepEqual(loadRuleSet(null), DEFAULT_RULES);
});

test("loadRuleSet merges a file's add/replace on top of the defaults", () => {
  withConfigFile('{"testPaths": {"add": ["\\\\.feature$"]}}', (path) => {
    const rules = loadRuleSet(path);
    assert.deepEqual(rules.testPaths, [...DEFAULT_RULES.testPaths, "\\.feature$"]);
  });
});

test("loadRuleSet throws when the file does not exist", () => {
  assert.throws(() => loadRuleSet("/nonexistent/does-not-exist-adg.json"), ConfigError);
});

test("loadRuleSet throws on a fragment that is not a valid regex", () => {
  withConfigFile('{"skips": {"add": ["(unclosed"]}}', (path) => {
    assert.throws(() => loadRuleSet(path), ConfigError);
  });
});
