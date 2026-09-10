#!/usr/bin/env node
// CLI entry point for the version check. Compares the version string carried
// by package.json, .claude-plugin/plugin.json, and package-lock.json's root
// version field, and fails when they disagree.
//
// Three files each carry this project's version, and nothing kept them in
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
//
// Exit codes:
//   0  every file agrees
//   1  the files disagree
//   2  the tool could not run as asked: a missing file, unparsable JSON, or
//      a file with no usable "version" field
//
// Exit 2 never looks like success: a file this tool could not read must
// never be reported as agreeing.

import process from "node:process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES: { label: string; path: string }[] = [
  { label: "package.json", path: join(ROOT, "package.json") },
  { label: ".claude-plugin/plugin.json", path: join(ROOT, ".claude-plugin", "plugin.json") },
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

function main(): void {
  const args = process.argv.slice(2);
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
