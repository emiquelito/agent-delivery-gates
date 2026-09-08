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
import {
  classifyTestPath,
  formatSignalText,
  separateTestDiff,
  type RuleSet,
  type SeparateResult,
  type Signal,
} from "../src/test-diff-separator.ts";
import { ConfigError, loadRuleSet, resolveConfigPath } from "../src/test-diff-config.ts";

const USAGE = `Usage: test-diff-separator [--rev REV] [--range A..B] [--staged] [--diff PATH] [--format text|json] [--config PATH]
       test-diff-separator --classify PATH... [--config PATH]

Separates the source diff from the test diff and reports weakening signals
found in the test files alone: a removed assertion, a removed test case, an
added skip, a widened tolerance, a raised timeout.

  --rev REV      the diff introduced by that commit (default: HEAD)
  --range A..B   the diff across that range
  --staged       the staged diff
  --diff PATH    read diff text from this file, or "-" for stdin
  --format FORMAT "text" (default) or "json"
  --config PATH  use this rules config instead of the usual lookup
  --classify PATH...  for each path, say whether it counts as a test file or
                 as source, and which rule decided; prints nothing else and
                 always exits 0
  --help         print this message and exit 0

Exactly one of --rev, --range, --staged, --diff, --classify may be given.

Rules config, first match wins:
  1. --config PATH
  2. ADG_TEST_DIFF_CONFIG in the environment
  3. .adg/test-diff.json in the repository root, if it exists
  4. the built-in defaults

Exit codes:
  0  no test file changed, or none of the changed test files carry a signal
     (or, with --classify, the classification was printed)
  1  at least one weakening signal was found
  2  could not run as asked, including a config that failed to load
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
  configPath?: string;
  classifyPaths?: string[];
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
      case "--config":
        result.configPath = argv[++i];
        if (result.configPath === undefined) fail("--config needs a path argument");
        break;
      case "--classify":
        {
          const paths: string[] = [];
          let j = i + 1;
          while (j < argv.length && !argv[j].startsWith("-")) {
            paths.push(argv[j]);
            j++;
          }
          if (paths.length === 0) fail("--classify needs at least one path argument");
          result.classifyPaths = paths;
          i = j - 1; // the for loop's i++ resumes right after the last path consumed
        }
        break;
      default:
        fail(`unknown argument '${arg}'`);
    }
  }

  const sourceCount = [
    result.rev !== undefined,
    result.range !== undefined,
    result.staged,
    result.diffPath !== undefined,
    result.classifyPaths !== undefined,
  ].filter(Boolean).length;
  if (sourceCount > 1) {
    fail("specify only one of --rev, --range, --staged, --diff, --classify");
  }

  return result;
}

/**
 * The repository root, used only to find .adg/test-diff.json. Returns
 * undefined instead of failing when there is no git repository here: a
 * missing default config file is not an error, and --classify in
 * particular has no other reason to need git at all.
 */
function tryResolveRepoRoot(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

function resolveRules(args: ParsedArgs): RuleSet {
  const repoRoot = tryResolveRepoRoot(process.cwd());
  const configPath = resolveConfigPath({ explicitPath: args.configPath, env: process.env, repoRoot });
  try {
    return loadRuleSet(configPath);
  } catch (err) {
    if (err instanceof ConfigError) fail(`config: ${err.message}`);
    throw err;
  }
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

/**
 * The git invocation for the diff the parsed arguments ask for. Shared by
 * resolveDiffText (the narrow, default-context run whose output is what
 * gets counted and printed) and widerClassificationSignals (the same
 * invocation, re-run wide, for classification only). Undefined for
 * --diff/stdin, which never invokes git at all.
 */
function gitInvocationArgs(args: ParsedArgs): string[] | undefined {
  if (args.diffPath !== undefined) return undefined;
  if (args.range !== undefined) {
    return ["diff", "--no-color", "--find-renames", args.range];
  }
  if (args.staged) {
    return ["diff", "--no-color", "--find-renames", "--staged"];
  }
  // Default and --rev: the diff introduced by that one commit. --root
  // makes this work for a commit with no parent by diffing against an
  // empty tree instead of failing.
  const rev = args.rev ?? "HEAD";
  // Rename detection is asked for on purpose. Without it git reports a rename
  // as a whole file added and a whole file deleted, and the check that a test
  // file left the naming convention never sees a rename to report.
  return ["diff-tree", "-p", "--no-color", "--root", "-r", "--find-renames", rev];
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
  return runGit(gitInvocationArgs(args)!);
}

// A .rs file's own `diff --git` or `+++` header line, present whether the
// file is new, deleted, modified, or renamed into/out of a .rs path.
const RUST_FILE_IN_DIFF_RE = /^(?:diff --git a\/.*\.rs b\/.*\.rs|\+\+\+ b\/.*\.rs)$/m;

/** Like runGit, but returns undefined instead of exiting on failure. Only
 * ever used for the wide re-run below, which is allowed to fail quietly:
 * it exists purely to find MORE signals than the narrow diff already did,
 * never to replace the narrow diff's own result. */
function runGitAllowFail(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return undefined;
  }
}

/** The same git invocation, widened to -U30. Flag order does not matter to
 * git here, so -U30 is simply inserted right after the subcommand. No size
 * check guards this: for a single file with a very large diff, -U30 can
 * pull in most of that file's lines, which roughly doubles git's work for
 * that one invocation. This is deliberate; see widerClassificationSignals. */
function widenContext(gitArgs: string[]): string[] {
  return [gitArgs[0], "-U30", ...gitArgs.slice(1)];
}

/**
 * When the diff came from git and touches a .rs file, re-runs the same git
 * invocation with a wide (-U30) context and classifies that wider text,
 * returning its signals. This exists because a Rust #[cfg(test)] module's
 * opener (or closer) can sit outside the default -U3 context window,
 * making the module invisible to src/test-diff-separator.ts's brace
 * matching even though the module is real; a wider window makes more of
 * these visible without changing what a human reads as "the diff".
 *
 * Added/removed counts and file stats are never taken from this: only
 * `.signals` is used, and only to add to what the narrow diff already
 * found, never to replace it. Returns undefined when the diff has no .rs
 * file, did not come from git at all (--diff/stdin: the bound documented
 * in src/test-diff-separator.ts simply applies there), or when the wide
 * re-run itself fails for any reason. A git failure here must degrade
 * quietly to the narrow diff's own result, never crash and never be
 * mistaken for "no signals".
 */
function widerClassificationSignals(args: ParsedArgs, narrowDiffText: string, rules: RuleSet): Signal[] | undefined {
  const gitArgs = gitInvocationArgs(args);
  if (gitArgs === undefined) return undefined;
  if (!RUST_FILE_IN_DIFF_RE.test(narrowDiffText)) return undefined;
  const wideText = runGitAllowFail(widenContext(gitArgs));
  if (wideText === undefined) return undefined;
  return separateTestDiff(wideText, { rules }).signals;
}

/** A signal's identity for deduplication: same finding, reported once. */
function signalKey(signal: Signal): string {
  return `${signal.id}\u0000${signal.file}\u0000${signal.line}\u0000${signal.message}`;
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

function runClassify(paths: string[], rules: RuleSet, format: "text" | "json"): void {
  const rows = paths.map((path) => {
    const { isTest, matchedRule } = classifyTestPath(path, rules);
    return { path, classification: isTest ? ("test" as const) : ("source" as const), matchedRule };
  });

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else {
    const lines = rows.map((row) => {
      const decided =
        row.matchedRule !== null
          ? `matched testPaths rule: ${row.matchedRule}`
          : "no testPaths rule matched";
      return `${row.path}: ${row.classification}  (${decided})`;
    });
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  process.exit(0);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const rules = resolveRules(args);

  if (args.classifyPaths !== undefined) {
    runClassify(args.classifyPaths, rules, args.format);
    return;
  }

  const diffText = resolveDiffText(args);
  const result = separateTestDiff(diffText, { rules });

  // A .rs file's #[cfg(test)] module can sit outside the default context
  // window; a wide re-run only ever adds signals the narrow diff missed,
  // never touches sourceFiles/testFiles/counts, and degrades silently to
  // nothing found when it cannot run at all. See widerClassificationSignals.
  const wideSignals = widerClassificationSignals(args, diffText, rules);
  if (wideSignals !== undefined) {
    const seen = new Set(result.signals.map(signalKey));
    for (const signal of wideSignals) {
      const key = signalKey(signal);
      if (seen.has(key)) continue;
      seen.add(key);
      result.signals.push(signal);
    }
    result.signalCount = result.signals.length;
  }

  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatText(result)}\n`);
  }

  process.exit(result.signals.length === 0 ? 0 : 1);
}

main();
