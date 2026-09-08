#!/usr/bin/env node
// CLI entry point for test-diff-separator. Vendor neutral: gets diff text
// from git or from a file/stdin, runs the pure separator in
// ../src/test-diff-separator.ts, and prints the source diff, the test
// diff, and any weakening signals found in the test files.
//
// Contract:
//   test-diff-separator [--rev REV] [--range A..B] [--staged] [--diff PATH] [--format text|json]
// Exit 0: no test file changed, or test files changed with no signals.
// Exit 1: at least one signal found. Exit 2: could not run as asked (bad
// argument, unreadable path, git failure, empty input where input was
// required). A git failure must never look like exit 0: an agent that
// broke git would otherwise read "no signals" as a pass.

import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync, readSync } from "node:fs";
import { formatSignalText, separateTestDiff, type SeparateResult } from "../src/test-diff-separator.ts";

const USAGE = `Usage: test-diff-separator [--rev REV] [--range A..B] [--staged] [--diff PATH] [--format text|json]

Separates the source diff from the test diff and reports weakening signals
found in the test files alone: a removed assertion, a removed test case, an
added skip, a widened tolerance, a raised timeout.

  --rev REV      the diff introduced by that commit (default: HEAD)
  --range A..B   the diff across that range
  --staged       the staged diff
  --diff PATH    read diff text from this file, or "-" for stdin
  --format FORMAT "text" (default) or "json"
  --help         print this message and exit 0

Exactly one of --rev, --range, --staged, --diff may be given.

Exit codes:
  0  no test file changed, or none of the changed test files carry a signal
  1  at least one weakening signal was found
  2  could not run as asked
`;

function fail(message: string): never {
  process.stderr.write(`test-diff-separator: ${message}\n`);
  process.exit(2);
}

/** Reads all of a stream's data and returns it as a string. */
function readAllOf(fd: number): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let read: number;
    try {
      read = readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") continue;
      if (code === "EOF") break;
      fail(`could not read stdin (${(err as Error).message})`);
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface ParsedArgs {
  rev?: string;
  range?: string;
  staged: boolean;
  diffPath?: string;
  format: "text" | "json";
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { staged: false, format: "text", help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;
      case "--rev":
        result.rev = argv[++i];
        if (result.rev === undefined) fail("--rev needs a commit argument");
        break;
      case "--range":
        result.range = argv[++i];
        if (result.range === undefined) fail("--range needs an A..B argument");
        break;
      case "--staged":
        result.staged = true;
        break;
      case "--diff":
        result.diffPath = argv[++i];
        if (result.diffPath === undefined) fail("--diff needs a path argument (or '-' for stdin)");
        break;
      case "--format":
        {
          const value = argv[++i];
          if (value !== "text" && value !== "json") {
            fail(`--format must be "text" or "json", got ${value === undefined ? "nothing" : `'${value}'`}`);
          }
          result.format = value;
        }
        break;
      default:
        fail(`unknown argument '${arg}'`);
    }
  }

  const sourceCount = [result.rev !== undefined, result.range !== undefined, result.staged, result.diffPath !== undefined].filter(
    Boolean,
  ).length;
  if (sourceCount > 1) {
    fail("specify only one of --rev, --range, --staged, --diff");
  }

  return result;
}

/**
 * Builds the environment for a git call with every GIT_* override removed,
 * the same way src/clean-tree-gate.ts does: a leftover GIT_DIR or
 * GIT_WORK_TREE would point git at a different tree, so this command could
 * report on the wrong repository entirely without ever failing.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

function runGit(args: string[]): string {
  try {
    return execFileSync("git", args, { env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = typeof e.stderr === "string" && e.stderr.trim() !== "" ? e.stderr.trim() : e.message ?? String(err);
    fail(`git failed (${args.join(" ")}): ${detail}`);
  }
}

/** Resolves the diff text to check from the parsed arguments. */
function resolveDiffText(args: ParsedArgs): string {
  if (args.diffPath !== undefined) {
    const text = args.diffPath === "-" ? readAllOf(0) : readFileOrFail(args.diffPath);
    if (text.trim() === "") {
      fail(`the diff is empty (${args.diffPath === "-" ? "stdin" : `'${args.diffPath}'`}); nothing to check`);
    }
    return text;
  }
  if (args.range !== undefined) {
    return runGit(["diff", "--no-color", args.range]);
  }
  if (args.staged) {
    return runGit(["diff", "--no-color", "--staged"]);
  }
  // Default and --rev: the diff introduced by that one commit. --root
  // makes this work for a commit with no parent by diffing against an
  // empty tree instead of failing.
  const rev = args.rev ?? "HEAD";
  return runGit(["diff-tree", "-p", "--no-color", "--root", "-r", rev]);
}

function readFileOrFail(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    fail(`could not read diff file '${path}' (${(err as Error).message})`);
  }
}

function formatText(result: SeparateResult): string {
  const lines: string[] = ["Source diff:"];
  if (result.sourceFiles.length === 0) {
    lines.push("  (no source files changed)");
  } else {
    for (const f of result.sourceFiles) lines.push(`  ${f.path}  +${f.added} -${f.removed}`);
  }
  lines.push("");

  if (result.testFiles.length === 0) {
    lines.push("Test diff: no test files changed.");
    // A signal can still exist with no test file in the diff: a test renamed
    // out of the naming rules leaves nothing classified as a test, and that
    // rename is the whole point. Returning early hid it.
    if (result.signals.length > 0) {
      lines.push("");
      lines.push(`Signals (${result.signals.length}):`);
      for (const signal of result.signals) lines.push(`  ${formatSignalText(signal)}`);
    }
    return lines.join("\n");
  }

  lines.push("Test diff:");
  for (const f of result.testFiles) lines.push(`  ${f.path}  +${f.added} -${f.removed}`);
  lines.push("");

  if (result.signals.length === 0) {
    lines.push("Signals: none found.");
  } else {
    lines.push(`Signals (${result.signals.length}):`);
    for (const signal of result.signals) lines.push(`  ${formatSignalText(signal)}`);
  }
  return lines.join("\n");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const diffText = resolveDiffText(args);
  const result = separateTestDiff(diffText);

  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatText(result)}\n`);
  }

  process.exit(result.signals.length === 0 ? 0 : 1);
}

main();
