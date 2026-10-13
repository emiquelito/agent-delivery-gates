#!/usr/bin/env node
// CLI entry point for the version check. Compares the version string carried
// by package.json, the Claude, Codex, and Copilot plugin manifests,
// gemini-extension.json, and package-lock.json's root version field, and
// fails when they disagree.
//
// Six files each carry this project's version, and nothing kept them in
// step before this: the plugin manifest once drifted three releases behind
// before anyone noticed. This is a report, not a hook: it lives in
// scripts/, not hooks/, which holds tools that gate a tool call.
//
// site/package.json is left out on purpose: it names a separate, private
// package ("agent-delivery-gates-site") with its own unrelated version, not
// a carrier of this package's version. Do not add it here.
//
// Contract:
//   check-versions [--check]
//   check-versions --set <version>
//
// --set writes one version into all six files so a release is not six
// hand edits. It accepts only a plain semantic version (1.2.3, optionally
// with -prerelease and +build), never a leading "v". It edits the version
// text in place and nothing else, so formatting, key order and trailing
// newlines survive; package-lock.json gets both its root version and the
// copy under packages[""], as npm itself writes them. Every file is
// prepared and re-parsed in memory before any is written, and the run
// refuses when any of the six files has uncommitted changes. Together
// these keep a failed run from leaving some files bumped and some not,
// and keep the resulting diff to the bump alone. Unrelated dirty files
// elsewhere in the tree do not matter, since --set never touches them.
//
// Exit codes:
//   0  every file agrees (or --set succeeded)
//   1  the files disagree
//   2  the tool could not run as asked: a missing file, unparsable JSON, or
//      a file with no usable "version" field; for --set, also an invalid
//      version, a dirty version file, or a file it cannot edit safely
//
// Exit 2 never looks like success: a file this tool could not read must
// never be reported as agreeing.

import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// CHECK_VERSIONS_ROOT lets the tests point the tool at a scratch copy.
const ROOT = process.env.CHECK_VERSIONS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES: { label: string; path: string }[] = [
  { label: "package.json", path: join(ROOT, "package.json") },
  { label: ".claude-plugin/plugin.json", path: join(ROOT, ".claude-plugin", "plugin.json") },
  { label: ".codex-plugin/plugin.json", path: join(ROOT, ".codex-plugin", "plugin.json") },
  { label: ".github/plugin/plugin.json", path: join(ROOT, ".github", "plugin", "plugin.json") },
  { label: "gemini-extension.json", path: join(ROOT, "gemini-extension.json") },
  { label: "package-lock.json", path: join(ROOT, "package-lock.json") },
];

function fail(message: string): never {
  process.stderr.write(`check-versions: ${message}\n`);
  process.exit(2);
}

function readVersion(label: string, path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(`could not read ${label} (${detail})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(`could not parse ${label} as JSON (${detail})`);
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== "string" || version === "") {
    return fail(`${label} has no usable "version" field`);
  }
  return version;
}

// Plain semver: no leading "v", no leading zeros in the numeric parts.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

// The top-level "version" line: a two-space-indented key. Nested objects sit
// deeper, so this cannot match a dependency's version.
const TOP_VERSION = /^(  "version": ")([^"\\]*)(")/gm;
// package-lock.json's packages[""] entry, as npm writes it.
const LOCK_ROOT_VERSION = /(^    "": \{\r?\n(?:(?!^    \}).*\r?\n)*?      "version": ")([^"\\]*)(")/m;

function replaceOnce(label: string, text: string, re: RegExp, version: string): string {
  const matches = text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  if (matches === null || matches.length !== 1) {
    return fail(`cannot safely edit ${label}: expected exactly one matching version line`);
  }
  return text.replace(re, (_m, a: string, _old: string, c: string) => `${a}${version}${c}`);
}

function prepareEdit(label: string, path: string, version: string): string {
  const text = readFileSync(path, "utf8");
  let next = replaceOnce(label, text, TOP_VERSION, version);
  const before = JSON.parse(text) as { packages?: Record<string, { version?: string }> };
  const hasLockRoot = before.packages?.[""]?.version !== undefined;
  if (label === "package-lock.json" && hasLockRoot) {
    next = replaceOnce(label, next, LOCK_ROOT_VERSION, version);
  }
  // Prove the edit: the result must parse, carry the new version, and equal
  // the original document with only the version fields changed.
  const expected = JSON.parse(text) as { version: string; packages?: Record<string, { version?: string }> };
  expected.version = version;
  if (label === "package-lock.json" && hasLockRoot) expected.packages![""].version = version;
  let actual: unknown;
  try {
    actual = JSON.parse(next);
  } catch {
    return fail(`editing ${label} produced invalid JSON; nothing was written`);
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    return fail(`editing ${label} changed more than the version; nothing was written`);
  }
  return next;
}

function assertCleanVersionFiles(): void {
  const status = spawnSync("git", ["status", "--porcelain", "--", ...SOURCES.map((s) => s.path)], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (status.error || status.status !== 0) {
    return fail("cannot tell whether the version files are committed (is this a git checkout?); nothing was written");
  }
  const dirty = status.stdout.split("\n").filter((l) => l !== "");
  if (dirty.length > 0) {
    return fail(`refusing to set the version: uncommitted changes in a version file\n${dirty.join("\n")}\ncommit or discard them first; nothing was written`);
  }
}

function setVersion(version: string): void {
  if (!SEMVER.test(version)) {
    return fail(`'${version}' is not a valid version; use a plain semantic version such as 1.2.3 or 1.2.3-rc.1 (no leading "v")`);
  }
  for (const { label, path } of SOURCES) readVersion(label, path);
  assertCleanVersionFiles();
  const edits = SOURCES.map(({ label, path }) => ({ path, text: prepareEdit(label, path, version) }));
  for (const { path, text } of edits) writeFileSync(path, text);
  process.stdout.write(`check-versions: set ${SOURCES.length} files to ${version}\n`);
  process.exit(0);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "--set") {
    if (args.length !== 2) fail("--set needs exactly one version argument");
    setVersion(args[1]);
  }
  const check = args.includes("--check");
  for (const arg of args) {
    if (arg !== "--check") fail(`unknown argument '${arg}'`);
  }

  const versions = SOURCES.map(({ label, path }) => ({ label, version: readVersion(label, path) }));
  const distinct = new Set(versions.map((v) => v.version));

  if (distinct.size === 1) {
    process.stdout.write(
      check
        ? "check-versions: no problems found\n"
        : `check-versions: all agree on ${versions[0].version}\n`,
    );
    process.exit(0);
  }

  for (const { label, version } of versions) {
    process.stdout.write(`${label}: ${version}\n`);
  }
  process.stderr.write("check-versions: version files disagree, see above\n");
  process.exit(1);
}

main();
