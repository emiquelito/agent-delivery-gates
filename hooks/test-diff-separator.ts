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
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { resolve, sep } from "node:path";
import { makeFileTextReader } from "../src/repo-file-reader.ts";
import { makeGitWholeFileReader, splitRange } from "../src/git-blob-reader.ts";
import {
  classifyTestPath,
  FIXTURE_MARKER,
  formatSignalText,
  separateTestDiff,
  separateTestDiffWarmed,
  type RuleSet,
  type SeparateResult,
  type Signal,
} from "../src/test-diff-separator.ts";
import { ConfigError, loadRuleSet, resolveConfigPath } from "../src/test-diff-config.ts";
import { installHintFor } from "../src/tree-sitter-grammars.ts";

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

A test file whose first 20 lines carry "adg-test-diff: fixtures" inside a
comment has its signal checks skipped: some files exist to hold text that
only looks like a weakening. Such a file is still a test file with its own
counts, and every run names every file it skipped.

Exit codes:
  0  no test file changed, or none of the changed test files carry a signal
     (or, with --classify, the classification was printed)
  1  at least one weakening signal was found
  2  could not run as asked, including a config that failed to load, or a
     touched file's tree-sitter grammar being present but failing to load
     (a corrupt install, an ABI mismatch -- a bug in this environment or
     this gate). A grammar that was simply never installed does not count
     here: that prints a warning naming what to run to install it, and the
     exit code is decided by the signals found, same as any other run.
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

/**
 * The two revisions bounding the diff the parsed arguments ask for, for
 * building a whole-file reader (see src/git-blob-reader.ts). Undefined for
 * --diff/stdin, which names no revision at all -- this CLI has no commit
 * to read a whole file from in that mode, so separateTestDiffWarmed below
 * gets no readWholeFile option and every line is masked alone, exactly as
 * this file worked before that option existed.
 *
 * --staged's new side is the index, not a commit: "" is git's own way of
 * naming it in `git show :path`. --range's two ends come from the range
 * string itself; splitRange gives up on a string with no ".." in it, which
 * degrades to the same no-reader case, never a hard failure. --rev and the
 * default both read one commit's own diff, so the old side is that
 * commit's first parent -- absent for a root commit, which is fine: a root
 * commit's diff (--root, diffed against the empty tree) never carries a
 * removed line for that missing side to matter to.
 */
function revisionsFor(args: ParsedArgs): { oldRev: string | null; newRev: string | null } | undefined {
  if (args.diffPath !== undefined) return undefined;
  if (args.range !== undefined) {
    const split = splitRange(args.range);
    return split === null ? undefined : { oldRev: split.oldRev, newRev: split.newRev };
  }
  if (args.staged) {
    return { oldRev: "HEAD", newRev: "" };
  }
  const rev = args.rev ?? "HEAD";
  return { oldRev: `${rev}^1`, newRev: rev };
}

/**
 * Builds the whole-file reader main() passes to separateTestDiffWarmed, or
 * undefined when one cannot be built: no repository root to run git
 * against, or revisionsFor above found no revision to read from (--diff/
 * stdin, or a --range string with no ".." in it).
 */
function buildWholeFileReader(
  args: ParsedArgs,
  repoRoot: string | undefined,
): ((path: string, side: "old" | "new") => string | undefined) | undefined {
  if (repoRoot === undefined) return undefined;
  const revisions = revisionsFor(args);
  if (revisions === undefined) return undefined;
  return makeGitWholeFileReader({ cwd: repoRoot, env: gitEnv(), ...revisions });
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
function widerClassificationSignals(
  args: ParsedArgs,
  narrowDiffText: string,
  rules: RuleSet,
  readFileText: (path: string) => string | undefined,
  readWholeFile: ((path: string, side: "old" | "new") => string | undefined) | undefined,
): Signal[] | undefined {
  const gitArgs = gitInvocationArgs(args);
  if (gitArgs === undefined) return undefined;
  if (!RUST_FILE_IN_DIFF_RE.test(narrowDiffText)) return undefined;
  const wideText = runGitAllowFail(widenContext(gitArgs));
  if (wideText === undefined) return undefined;
  // Same reader, so a file exempt in the narrow run is exempt here too: the
  // wide re-run must never reintroduce a signal the marker suppressed. The
  // whole-file reader is the same one too -- the wider context window only
  // changes how much of the diff's own hunks are visible, never which
  // commits bound "old" and "new", so there is nothing for it to recompute.
  return separateTestDiff(wideText, { rules, readFileText, readWholeFile }).signals;
}

// Only the head of a file is ever read: the marker has to sit within the
// first 20 lines, so nothing past this is of any interest, and a large file
// named in a diff should not be pulled into memory whole to check one line.

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

/**
 * The exempt-file block, printed immediately above the signal count on
 * every run that skipped a file, whether or not anything else was found.
 * A clean run that skipped two files must not read the same as a clean run
 * that skipped none, so this is never folded away and never moved to the
 * end where a reader stops before reaching it.
 */
function exemptBlock(result: SeparateResult): string[] {
  if (result.exemptFiles.length === 0) return [];
  const lines = [`Exempt from signals (${result.exemptCount}), each carrying the "${FIXTURE_MARKER}" marker:`];
  for (const path of result.exemptFiles) lines.push(`  ${path}`);
  lines.push("");
  return lines;
}

function signalBlock(result: SeparateResult): string[] {
  if (result.signals.length === 0) return ["Signals: none found."];
  const lines = [`Signals (${result.signals.length}):`];
  for (const signal of result.signals) lines.push(`  ${formatSignalText(signal)}`);
  return lines;
}

/** Same reasoning as exemptBlock above, for the three ways a mask can be
 * less than fully trustworthy: see grammarLoadFailedExtensions,
 * grammarAbsentExtensions, and unwarmedExtensions on SeparateResult. A
 * clean-looking run whose mask was not trustworthy for some of what it
 * scanned must still say so, not read the same as a run that scanned
 * everything cleanly.
 *
 * grammarLoadFailedExtensions (a real failure: the package is present
 * and something about the load still broke) is the one of the three this
 * CLI does not leave as a plain warning: see the exit-code decision in
 * main() below, where it now turns exit 2, the same way a git failure
 * already does. grammarAbsentExtensions (the package was never installed
 * -- the ordinary state for an adopter who installed this tool the way
 * its own README says to) and unwarmedExtensions both stay warnings only,
 * with the run's exit code left to the signals actually found. */
function warningBlock(result: SeparateResult): string[] {
  const lines: string[] = [];
  if (result.grammarLoadFailedExtensions.length > 0) {
    lines.push(
      `Warning: grammar failed to load for ${result.grammarLoadFailedExtensions.join(", ")}; those files were ` +
        "scanned with the regex fallback and may have missed a string, a comment, or an interpolation. This is a " +
        "bug in the environment or the gate, not in the commit; see the exit code below.",
    );
  }
  if (result.grammarAbsentExtensions.length > 0) {
    lines.push(
      `Warning: grammar not installed for ${result.grammarAbsentExtensions.join(", ")}; those files were scanned ` +
        "with the regex fallback and may have missed a string, a comment, or an interpolation. This is expected " +
        `until you install it: run \`${installHintFor(result.grammarAbsentExtensions)}\` in your project. Not ` +
        "blocking this run; treat it as unmeasured for those files, not as clean.",
    );
  }
  if (result.unwarmedExtensions.length > 0) {
    lines.push(
      `Warning: ${result.unwarmedExtensions.join(", ")} file(s) were masked before their language service ` +
        "warmed; this result may be less accurate than usual for those files.",
    );
  }
  if (lines.length > 0) lines.push("");
  return lines;
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
    lines.push("");
    lines.push(...exemptBlock(result));
    lines.push(...warningBlock(result));
    // A signal can still exist with no test file in the diff: a test renamed
    // out of the naming rules leaves nothing classified as a test, and that
    // rename is the whole point. Returning early hid it.
    if (result.signals.length > 0) {
      lines.push(`Signals (${result.signals.length}):`);
      for (const signal of result.signals) lines.push(`  ${formatSignalText(signal)}`);
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }

  lines.push("Test diff:");
  for (const f of result.testFiles) lines.push(`  ${f.path}  +${f.added} -${f.removed}`);
  lines.push("");

  lines.push(...exemptBlock(result));
  lines.push(...warningBlock(result));
  lines.push(...signalBlock(result));
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

async function main(): Promise<void> {
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

  const repoRoot = tryResolveRepoRoot(process.cwd());
  const readFileText = makeFileTextReader(repoRoot ?? process.cwd());

  // The two commits (or commit and index) this diff sits between, so a
  // changed file can be read and masked whole instead of one diff line at
  // a time; see src/git-blob-reader.ts and src/test-diff-separator.ts's
  // own FileMaskContext. undefined in --diff/stdin mode, where there is no
  // revision to read from at all, and every mask then falls back to
  // per-line, exactly as this CLI worked before this option existed. Also
  // undefined with no repository root to run git against.
  const readWholeFile = buildWholeFileReader(args, repoRoot);

  const diffText = resolveDiffText(args);
  // A .py file is masked by the tree-sitter service once it is loaded for
  // this process; loading it is not synchronous, so warming has to happen
  // ahead of separateTestDiff, which stays a plain synchronous function.
  // separateTestDiffWarmed does both, in order, so this call site cannot
  // forget the warm the way src/agent-adapter.ts once did.
  const result = await separateTestDiffWarmed(diffText, { rules, readFileText, readWholeFile });

  // A .rs file's #[cfg(test)] module can sit outside the default context
  // window; a wide re-run only ever adds signals the narrow diff missed,
  // never touches sourceFiles/testFiles/counts, and degrades silently to
  // nothing found when it cannot run at all. See widerClassificationSignals.
  const wideSignals = widerClassificationSignals(args, diffText, rules, readFileText, readWholeFile);
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

  // A reviewer flagged that this used to leave the exit code untouched on
  // a real grammar-load failure (the package is present and something
  // about the load still broke): the report printed a warning, but the
  // exit code still came only from result.signals.length, so a run that
  // could not trust its own mask for a file could still exit 0 -- read as
  // clean the same way `Exit codes` at the top of this file's own USAGE
  // documents a git failure must never be allowed to. Fixed the same way:
  // exit 2, "could not run as asked", ahead of whatever the signal count
  // says. grammarAbsentExtensions (the package was never installed, the
  // ordinary state for most adopters -- see warningBlock above) does NOT
  // affect the exit code: that is not a failure to run as asked, it is an
  // environment fact this CLI already prints a warning for, and the run
  // itself is trusted to keep going.
  const exitCode = result.grammarLoadFailedExtensions.length > 0 ? 2 : result.signals.length === 0 ? 0 : 1;
  process.exit(exitCode);
}

main().catch((err) => {
  // main() became async once it had to warm the Python language service
  // before separating a diff. A bare `main()` call with no `.catch` hands
  // an uncaught rejection to Node's default handling: exit 1 with a raw
  // stack trace, a code this file does not document. The documented
  // contract is exit 2 for anything this tool could not run as asked; an
  // uncaught async failure is exactly that.
  fail(`internal error: ${(err as Error).message}`);
});
